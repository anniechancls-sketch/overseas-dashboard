const fetch = require('node-fetch');

// 版本: 2026-03-13 - GitHub存储版本
// GitHub配置
const GITHUB_OWNER = 'anniechancls-sketch';
const GITHUB_REPO = 'overseas-dashboard';
const DATA_BRANCH = 'main';

// GitHub API Token
function getGitHubToken() {
  return process.env.GITHUB_TOKEN;
}

// 推送到GitHub
async function pushToGitHub(filename, content, message) {
  const token = getGitHubToken();
  if (!token) {
    console.log('未设置GITHUB_TOKEN');
    return false;
  }
  
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data/${filename}`;
    
    // 检查文件是否存在
    let sha = null;
    try {
      const checkRes = await fetch(apiUrl, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (checkRes.status === 200) {
        const checkData = await checkRes.json();
        sha = checkData.sha;
      }
    } catch (e) {}
    
    // 创建或更新
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
      body: JSON.stringify(body)
    });
    
    if (res.status === 200 || res.status === 201) {
      console.log(`GitHub推送成功: ${filename}`);
      return true;
    }
    const error = await res.text();
    console.log(`GitHub推送失败: ${res.status} - ${error}`);
    return false;
  } catch (e) {
    console.log('GitHub推送错误:', e.message);
    return false;
  }
}

// 内存存储
const memoryStore = new Map();

async function storeData(key, value) {
  memoryStore.set(key, value);
}

async function getData(key) {
  return memoryStore.get(key) || null;
}

// 推送到GitHub的函数
async function pushRatesToGitHub(rates, source, date) {
  if (!getGitHubToken()) return;
  
  const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
  const ratesObj = {};
  targets.forEach(code => { if (rates[code]) ratesObj[code] = rates[code]; });
  
  const data = {
    date: date,
    source: source,
    base: 'USD',
    rates: ratesObj,
    updatedAt: new Date().toISOString()
  };
  
  await pushToGitHub(`${date}.json`, JSON.stringify(data, null, 2), `汇率数据: ${date} (${source})`);
}

// 中国银行外汇牌价
const BOC_URL = 'https://www.boc.cn/sourcedb/whpj/';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const today = new Date().toISOString().split('T')[0];
  
  if (!getGitHubToken()) {
    console.log('未设置GITHUB_TOKEN');
  }
  
  try {
    const bocData = await fetchBOCRates();
    if (bocData.success) {
      const processed = await processRates(bocData.rates, today);
      await pushRatesToGitHub(bocData.rates, '中国银行', today);
      return res.json({ 
        success: true, source: '中国银行', date: today, rates: processed,
        github: getGitHubToken() ? '已推送' : '未配置'
      });
    }
  } catch (e) {}
  
  try {
    const fallback = await fetchFallbackRates();
    const processed = await processRates(fallback.rates, today);
    await pushRatesToGitHub(fallback.rates, 'exchangerate', today);
    return res.json({ 
      success: true, source: 'exchangerate (备用)', date: today, rates: processed,
      github: getGitHubToken() ? '已推送' : '未配置'
    });
  } catch (e) {
    return res.status(500).json({ error: '失败' });
  }
};

async function fetchBOCRates() {
  const res = await fetch(BOC_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN'
    },
    timeout: 10000
  });
  const html = await res.text();
  
  const today = new Date().toISOString().split('T')[0];
  const currencyMap = {
    '美元': 'USD', '欧元': 'EUR', '英镑': 'GBP', '泰国铢': 'THB',
    '印尼卢比': 'IDR', '卢布': 'RUB', '菲律宾比索': 'PHP', '越南盾': 'VND'
  };
  
  const rates = {};
  for (const [cn, code] of Object.entries(currencyMap)) {
    const pattern = new RegExp(`${cn}[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>`);
    const match = html.match(pattern);
    if (match && match[4]) {
      const rate = parseFloat(match[4]);
      if (!isNaN(rate) && rate > 0) rates[code] = rate;
    }
  }
  
  if (!rates.USD) throw new Error('无USD数据');
  
  const usdCnyRate = rates.USD;
  const usdBased = { USD: 1.0 };
  
  for (const [code, cnyRate] of Object.entries(rates)) {
    if (code !== 'USD') usdBased[code] = usdCnyRate / cnyRate;
  }
  usdBased.CNY = usdCnyRate / 100;
  
  // 补充币种
  try {
    const fb = await fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r => r.json());
    ['MXN', 'PLN'].forEach(c => { if (fb.rates[c] && !usdBased[c]) usdBased[c] = fb.rates[c]; });
  } catch (e) {}
  
  return { success: true, rates: usdBased, date: today };
}

async function fetchFallbackRates() {
  const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
  const data = await res.json();
  const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
  const rates = {};
  targets.forEach(c => { if (data.rates[c]) rates[c] = data.rates[c]; });
  return { success: true, rates, date: data.date };
}

async function processRates(rates, date) {
  const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
  const names = { 
    CNY: '人民币', EUR: '欧元', GBP: '英镑', IDR: '印尼盾', RUB: '卢布', 
    PHP: '菲律宾比索', PLN: '兹罗提', THB: '泰铢', MXN: '墨西哥比索', VND: '越南盾' 
  };
  
  const result = [];
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yestKey = yesterday.toISOString().split('T')[0];
  
  for (const code of targets) {
    const rate = rates[code];
    if (!rate) continue;
    
    let change = 0, trend = 'up';
    const yestRate = await getData(`${code}:${yestKey}`);
    if (yestRate) {
      change = ((rate - yestRate) / yestRate) * 100;
      trend = change >= 0 ? 'up' : 'down';
    }
    
    await storeData(`${code}:${date}`, rate);
    
    result.push({
      code, name: names[code],
      rate: code === 'IDR' || code === 'VND' ? rate.toFixed(2) : rate.toFixed(4),
      change: change.toFixed(2), trend
    });
  }
  
  return result;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}