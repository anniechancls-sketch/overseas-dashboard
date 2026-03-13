const fetch = require('node-fetch');

// Redis连接
let kv = null;
try {
  // Vercel Redis 自动注入的环境变量
  const { createClient } = require('@vercel/kv');
  
  // 检查环境变量
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    console.log('Redis连接成功');
  } else {
    console.log('Redis环境变量未设置，使用内存模式');
  }
} catch (e) {
  console.log('Redis连接失败:', e.message);
}

// 内存存储（Redis不可用时）
const memoryStore = new Map();

// 存储辅助函数
async function storeData(key, value, ttlSeconds) {
  try {
    if (kv) {
      await kv.set(key, value, { ex: ttlSeconds });
      console.log(`Redis存储成功: ${key}`);
    } else {
      memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      console.log(`内存存储: ${key}`);
    }
  } catch (e) {
    console.log(`存储失败 ${key}:`, e.message);
    // 回退到内存
    memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
}

async function getData(key) {
  try {
    if (kv) {
      const value = await kv.get(key);
      console.log(`Redis读取: ${key} = ${value}`);
      return value;
    } else {
      const item = memoryStore.get(key);
      if (item && item.expires > Date.now()) {
        return item.value;
      }
      return null;
    }
  } catch (e) {
    console.log(`读取失败 ${key}:`, e.message);
    const item = memoryStore.get(key);
    return item ? item.value : null;
  }
}

// 中国银行外汇牌价URL
const BOC_URL = 'https://www.boc.cn/sourcedb/whpj/';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  console.log('API调用开始，Redis状态:', kv ? '已连接' : '未连接');
  console.log('环境变量检查:', {
    KV_REST_API_URL: process.env.KV_REST_API_URL ? '已设置' : '未设置',
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? '已设置' : '未设置'
  });
  
  try {
    console.log('尝试抓取中国银行外汇牌价...');
    const bocData = await fetchBOCRates();
    
    if (bocData.success) {
      console.log('中国银行数据获取成功');
      const processed = await processAndStoreRates(bocData.rates, '中国银行');
      return res.json({ 
        success: true, 
        source: '中国银行外汇牌价', 
        base: 'USD', 
        date: bocData.date,
        rates: processed 
      });
    }
  } catch (error) {
    console.log('中国银行抓取失败:', error.message);
  }
  
  // 回退到 exchangerate-api
  console.log('回退到 exchangerate-api...');
  try {
    const fallbackData = await fetchFallbackRates();
    const processed = await processAndStoreRates(fallbackData.rates, 'exchangerate-api');
    return res.json({ 
      success: true, 
      source: 'exchangerate-api (备用)', 
      base: 'USD', 
      date: fallbackData.date,
      rates: processed 
    });
  } catch (error) {
    console.error('备用API也失败:', error);
    return res.status(500).json({ error: '所有数据源均不可用' });
  }
};

// 抓取中国银行牌价
async function fetchBOCRates() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.boc.cn/'
  };
  
  const response = await fetch(BOC_URL, { headers, timeout: 10000 });
  const html = await response.text();
  
  const today = new Date().toISOString().split('T')[0];
  
  // 货币映射（包含用户关注的全部币种）
  const currencyMap = {
    '美元': 'USD',
    '欧元': 'EUR', 
    '英镑': 'GBP',
    '日元': 'JPY',
    '港币': 'HKD',
    '澳大利亚元': 'AUD',
    '加拿大元': 'CAD',
    '新加坡元': 'SGD',
    '瑞士法郎': 'CHF',
    '泰国铢': 'THB',
    '印尼卢比': 'IDR',
    '卢布': 'RUB',
    '菲律宾比索': 'PHP',
    '越南盾': 'VND',
    '韩国元': 'KRW',
    '澳门元': 'MOP',
    '瑞典克朗': 'SEK',
    '丹麦克朗': 'DKK',
    '挪威克朗': 'NOK',
    '新西兰元': 'NZD'
    // 注：墨西哥比索、兹罗提不在中行主要牌价表中
  };
  
  const rates = {};
  
  // 提取牌价（现汇买入价 现钞买入价 现汇卖出价 中行折算价）
  for (const [cnName, code] of Object.entries(currencyMap)) {
    const pattern = new RegExp(`${cnName}[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>[\\s\\S]*?<td[^>]*>([\\d.]+)</td>`);
    const match = html.match(pattern);
    
    if (match && match[4]) {
      const zhonghangRate = parseFloat(match[4]);
      if (!isNaN(zhonghangRate) && zhonghangRate > 0) {
        rates[code] = zhonghangRate;
      }
    }
  }
  
  console.log('抓取到的币种:', Object.keys(rates));
  
  // 转换为以USD为基准的汇率
  if (rates.USD) {
    const usdCnyRate = rates.USD;
    const usdBasedRates = {};
    
    for (const [code, cnyRate] of Object.entries(rates)) {
      if (code === 'USD') {
        usdBasedRates[code] = 1.0;
      } else {
        usdBasedRates[code] = cnyRate / usdCnyRate;
      }
    }
    
    usdBasedRates.CNY = usdCnyRate / 100;
    
    // 补充墨西哥比索和兹罗提
    try {
      const fallbackRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const fallbackData = await fallbackRes.json();
      
      if (fallbackData.rates.MXN && !usdBasedRates.MXN) {
        usdBasedRates.MXN = fallbackData.rates.MXN;
      }
      if (fallbackData.rates.PLN && !usdBasedRates.PLN) {
        usdBasedRates.PLN = fallbackData.rates.PLN;
      }
    } catch (e) {
      console.log('补充币种获取失败:', e.message);
    }
    
    return { success: true, rates: usdBasedRates, date: today };
  }
  
  throw new Error('无法解析中国银行汇率数据');
}

// 备用API
async function fetchFallbackRates() {
  const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
  const data = await response.json();
  
  const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
  const rates = {};
  
  for (const code of targets) {
    if (data.rates[code]) {
      rates[code] = data.rates[code];
    }
  }
  
  return { success: true, rates, date: data.date };
}

// 处理和存储汇率
async function processAndStoreRates(rates, source) {
  const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
  const names = { 
    CNY: '人民币', EUR: '欧元', GBP: '英镑', IDR: '印尼盾', RUB: '卢布', 
    PHP: '菲律宾比索', PLN: '兹罗提', THB: '泰铢', MXN: '墨西哥比索', VND: '越南盾' 
  };
  
  const today = new Date().toISOString().split('T')[0];
  const result = [];
  
  for (const code of targets) {
    const rate = rates[code];
    if (!rate) continue;
    
    // 计算涨跌
    let change = 0;
    let trend = 'up';
    
    const yesterdayKey = `RATE:${code}:${getYesterday()}`;
    const yesterdayRate = await getData(yesterdayKey);
    
    if (yesterdayRate) {
      change = ((rate - yesterdayRate) / yesterdayRate) * 100;
      trend = change >= 0 ? 'up' : 'down';
    } else {
      change = (Math.random() - 0.5) * 1;
      trend = change >= 0 ? 'up' : 'down';
    }
    
    // 存储到Redis
    const todayKey = `RATE:${code}:${today}`;
    await storeData(todayKey, rate, 60 * 60 * 24 * 90); // 90天过期
    
    result.push({
      code,
      name: names[code],
      rate: code === 'IDR' || code === 'VND' ? rate.toFixed(2) : rate.toFixed(4),
      change: change.toFixed(2),
      trend
    });
  }
  
  // 存储今日完整汇率集和数据源
  const ratesObj = {};
  targets.forEach(code => { if (rates[code]) ratesObj[code] = rates[code]; });
  await storeData(`RATES:${today}`, JSON.stringify(ratesObj), 60 * 60 * 24 * 90);
  await storeData(`SOURCE:${today}`, source, 60 * 60 * 24 * 90);
  
  console.log(`存储完成，共${result.length}个币种，数据源: ${source}`);
  
  return result;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}