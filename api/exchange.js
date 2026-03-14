const fetch = require('node-fetch');

// ========== 配置 ==========
const GITHUB_OWNER = 'anniechancls-sketch';
const GITHUB_REPO = 'overseas-dashboard';
const DATA_BRANCH = 'data';
const BOC_URL = 'https://www.boc.cn/sourcedb/whpj/';

// 目标货币
const TARGET_CURRENCIES = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
const CURRENCY_NAMES = {
  CNY: '人民币', EUR: '欧元', GBP: '英镑', IDR: '印尼盾', RUB: '卢布',
  PHP: '菲律宾比索', PLN: '兹罗提', THB: '泰铢', MXN: '墨西哥比索', VND: '越南盾'
};
const CURRENCY_MAP = {
  '美元': 'USD', '欧元': 'EUR', '英镑': 'GBP', '泰国铢': 'THB',
  '印尼卢比': 'IDR', '卢布': 'RUB', '菲律宾比索': 'PHP', '越南盾': 'VND'
};

// ========== 缓存 (5分钟有效) ==========
let cache = { 
  data: null, 
  timestamp: 0,
  lastPushDate: null  // 记录最近一次推送的日期
};
const CACHE_TTL = 5 * 60 * 1000;

function getGitHubToken() {
  return process.env.GITHUB_TOKEN;
}

// ========== GitHub 推送 ==========
async function pushToGitHub(filename, content, message) {
  const token = getGitHubToken();
  if (!token) {
    console.log('❌ 未设置GITHUB_TOKEN');
    return { success: false, error: 'NO_TOKEN' };
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/rates/${filename}`;

  try {
    // 检查文件是否存在 (获取SHA)
    let sha = null;
    try {
      const checkRes = await fetch(apiUrl, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000 // 10秒超时
      });
      if (checkRes.status === 200) {
        const checkData = await checkRes.json();
        sha = checkData.sha;
      }
    } catch (e) {
      console.log('文件不存在，将创建新文件');
    }

    // 推送
    const body = {
      message: message,
      content: Buffer.from(content).toString('base64'),
      branch: DATA_BRANCH
    };
    if (sha) body.sha = sha;

    const res = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      timeout: 10000 // 10秒超时
    });

    if (res.status === 200 || res.status === 201) {
      console.log(`✅ GitHub推送成功: ${filename}`);
      return { success: true };
    }

    const error = await res.text();
    console.log(`❌ GitHub推送失败: ${res.status} - ${error}`);
    return { success: false, error: `${res.status}: ${error}` };
  } catch (e) {
    console.log('❌ GitHub推送错误:', e.message);
    return { success: false, error: e.message };
  }
}

// ========== 内存存储 (用于跨请求对比) ==========
const memoryStore = new Map();

async function storeData(key, value) {
  memoryStore.set(key, value);
}

async function getData(key) {
  return memoryStore.get(key) || null;
}

// ========== 中国银行汇率 ==========
async function fetchBOCRates() {
  console.log('🌐 抓取中国银行汇率...');
  
  try {
    const res = await fetch(BOC_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      timeout: 10000 // node-fetch 2.x原生支持10秒超时
    });

    const html = await res.text();
    const rates = {};

    for (const [cn, code] of Object.entries(CURRENCY_MAP)) {
      // 匹配: 币种名 + 4个td (现汇买入价, 现钞买入价, 现汇卖出价, 现钞卖出价)
      const pattern = new RegExp(`${cn}[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>`);
      const match = html.match(pattern);
      if (match && match[4]) {
        const rate = parseFloat(match[4]); // 现钞卖出价
        if (!isNaN(rate) && rate > 0) rates[code] = rate;
      }
    }

    if (!rates.USD) {
      throw new Error('❌ 未获取到USD汇率');
    }

    // BOC: 100外币 = X CNY → 转换为: 1 USD = ? 外币
    const usdCnyRate = rates.USD;
    const usdBased = { USD: 1.0 };

    for (const [code, cnyRate] of Object.entries(rates)) {
      if (code !== 'USD') {
        // 1 USD = (usdCnyRate/100) CNY ÷ (cnyRate/100) 外币 = usdCnyRate / cnyRate 外币
        usdBased[code] = usdCnyRate / cnyRate;
      }
    }

    // CNY: 100 USD = usdCnyRate CNY → 1 USD = usdCnyRate / 100 CNY
    usdBased.CNY = usdCnyRate / 100;

    // 补充MXN, PLN (BOC没有的)
    try {
      const fb = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { 
        timeout: 5000 // 5秒超时
      });
      const fbData = await fb.json();
      ['MXN', 'PLN'].forEach(c => {
        if (fbData.rates[c] && !usdBased[c]) usdBased[c] = fbData.rates[c];
      });
    } catch (e) {
      console.log('⚠️ 备用API获取失败:', e.message);
    }

    console.log('✅ 中国银行汇率获取成功');
    return { success: true, rates: usdBased };
    
  } catch (error) {
    console.log('❌ 中国银行API请求失败:', error.message);
    throw error;
  }
}

// ========== 备用汇率API ==========
async function fetchFallbackRates() {
  console.log('🌐 使用备用API (exchangerate-api)...');
  
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      timeout: 10000 // 10秒超时
    });
    
    const data = await res.json();
    const rates = {};
    TARGET_CURRENCIES.forEach(c => {
      if (data.rates[c]) rates[c] = data.rates[c];
    });

    return { success: true, rates, date: data.date };
    
  } catch (error) {
    console.log('❌ 备用API请求失败:', error.message);
    throw error;
  }
}

// ========== 推送到GitHub ==========
async function pushRatesToGitHub(rates, source, date) {
  const token = getGitHubToken();
  if (!token) {
    console.log('❌ GitHub Token未设置或为空');
    return { success: false, error: 'NO_TOKEN' };
  }
  console.log('✅ GitHub Token存在，长度:', token.length);

  const ratesObj = {};
  TARGET_CURRENCIES.forEach(code => {
    if (rates[code]) ratesObj[code] = rates[code];
  });

  const data = {
    date: date,
    source: source,
    base: 'USD',
    rates: ratesObj,
    updatedAt: new Date().toISOString()
  };

  return await pushToGitHub(
    `${date}.json`,
    JSON.stringify(data, null, 2),
    `汇率数据: ${date} (${source})`
  );
}

// ========== 处理汇率数据 ==========
async function processRates(rates, date) {
  const result = [];

  // 计算昨日数据用于对比
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yestKey = yesterday.toISOString().split('T')[0];

  for (const code of TARGET_CURRENCIES) {
    const rate = rates[code];
    if (!rate) continue;

    let change = 0;
    let trend = 'up';

    // 从内存存储获取昨日汇率
    const yestRate = await getData(`${code}:${yestKey}`);
    if (yestRate) {
      change = ((rate - yestRate) / yestRate) * 100;
      trend = change >= 0 ? 'up' : 'down';
    }

    // 存储今日汇率
    await storeData(`${code}:${date}`, rate);

    result.push({
      code,
      name: CURRENCY_NAMES[code],
      rate: (code === 'IDR' || code === 'VND') ? rate.toFixed(2) : rate.toFixed(4),
      change: change.toFixed(2),
      trend
    });
  }

  return result;
}

// ========== 主处理函数 ==========
async function getExchangeData(forceRefresh = false) {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  
  // 检查是否需要强制刷新（包括cron触发或今天首次推送）
  const isFirstPushToday = !cache.lastPushDate || cache.lastPushDate !== today;
  const shouldForceRefresh = forceRefresh || isFirstPushToday;
  
  // 检查缓存，除非需要强制刷新
  if (!shouldForceRefresh && cache.data && (now - cache.timestamp) < CACHE_TTL) {
    console.log('📦 使用缓存数据');
    return cache.data;
  }

  console.log(`🔄 ${shouldForceRefresh ? '强制刷新' : '缓存失效'}，获取最新数据...`);
  if (isFirstPushToday) {
    console.log(`📅 今天首次推送: ${today}`);
  }
  
  let rates, source;

  // 优先使用中国银行
  try {
    const bocData = await fetchBOCRates();
    if (bocData.success) {
      rates = bocData.rates;
      source = '中国银行';
      console.log('✅ 中国银行数据获取成功');
    }
  } catch (e) {
    console.log('❌ 中国银行API失败:', e.message);
  }

  // 备用: exchangerate-api
  if (!rates) {
    try {
      const fallback = await fetchFallbackRates();
      rates = fallback.rates;
      source = 'exchangerate (备用)';
      console.log('✅ 备用API数据获取成功');
    } catch (e) {
      throw new Error('所有汇率API均失败');
    }
  }

  // 处理并推送
  const processed = await processRates(rates, today);
  console.log(`📊 处理了 ${processed.length} 种货币汇率`);
  
  const pushResult = await pushRatesToGitHub(rates, source, today);
  console.log(`📤 GitHub推送结果:`, pushResult);

  const result = {
    success: true,
    source: source,
    date: today,
    rates: processed,
    github: pushResult?.success ? '✅ 已推送' : `❌ ${pushResult?.error || '未知错误'}`,
    githubDetails: pushResult, // 添加详细推送信息
    timestamp: new Date().toISOString(),
    debug: {
      isFirstPushToday,
      shouldForceRefresh,
      cacheTimestamp: cache.timestamp,
      now
    }
  };
  
  cache.data = result;
  cache.timestamp = now;
  
  // 如果GitHub推送成功，更新最后推送日期
  if (pushResult?.success) {
    cache.lastPushDate = today;
    console.log(`📅 已更新最后推送日期: ${today}`);
  }
  
  console.log(`🎉 数据更新完成: ${source}, GitHub推送: ${pushResult?.success ? '成功' : '失败'}`);
  
  return result;
}

// ========== Vercel API 入口 ==========
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 检查是否是cron触发的请求
  const isCron = req.url.includes('cron=true') || req.headers['x-vercel-cron'] === 'true';
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19);
  
  if (isCron) {
    console.log(`⏰ Cron任务触发: ${timeStr} (北京时间)`);
    console.log(`📊 请求URL: ${req.url}`);
  } else {
    console.log(`🌐 普通API请求: ${timeStr}`);
  }

  try {
    const data = await getExchangeData(isCron); // Cron请求强制刷新
    const response = {
      ...data,
      triggeredBy: isCron ? 'cron' : 'manual',
      serverTime: timeStr
    };
    
    return res.json(response);
  } catch (e) {
    console.error('❌ API错误:', e.message);
    const errorResponse = {
      error: e.message,
      triggeredBy: isCron ? 'cron' : 'manual',
      serverTime: timeStr,
      success: false
    };
    return res.status(500).json(errorResponse);
  }
};