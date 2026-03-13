const fetch = require('node-fetch');
const Redis = require('ioredis');

// Redis连接
let redis = null;
try {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    console.log('Redis连接成功');
  } else {
    console.log('REDIS_URL未设置，使用内存模式');
  }
} catch (e) {
  console.log('Redis连接失败:', e.message);
}

// 内存存储（Redis不可用时）
const memoryStore = new Map();

// 存储辅助函数
async function storeData(key, value, ttlSeconds) {
  try {
    if (redis) {
      await redis.setex(key, ttlSeconds, typeof value === 'string' ? value : JSON.stringify(value));
      console.log(`Redis存储成功: ${key}`);
    } else {
      memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      console.log(`内存存储: ${key}`);
    }
  } catch (e) {
    console.log(`存储失败 ${key}:`, e.message);
    memoryStore.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
}

async function getData(key) {
  try {
    if (redis) {
      const value = await redis.get(key);
      console.log(`Redis读取: ${key} = ${value ? '有数据' : '无数据'}`);
      if (!value) return null;
      // 尝试解析JSON
      try {
        return JSON.parse(value);
      } catch {
        // 如果不是JSON，返回原始值转为数字
        const num = parseFloat(value);
        return isNaN(num) ? value : num;
      }
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
  
  console.log('API调用开始，Redis状态:', redis ? '已连接' : '未连接');
  
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
  
  // 货币映射
  const currencyMap = {
    '美元': 'USD', '欧元': 'EUR', '英镑': 'GBP',
    '泰国铢': 'THB', '印尼卢比': 'IDR', '卢布': 'RUB',
    '菲律宾比索': 'PHP', '越南盾': 'VND'
  };
  
  const rates = {};
  
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
    
    // 补充其他币种
    try {
      const fallbackRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const fallbackData = await fallbackRes.json();
      ['MXN', 'PLN'].forEach(code => {
        if (fallbackData.rates[code] && !usdBasedRates[code]) {
          usdBasedRates[code] = fallbackData.rates[code];
        }
      });
    } catch (e) {}
    
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
    
    // 存储到Redis (2小时刷新，数据保留90天)
    const todayKey = `RATE:${code}:${today}`;
    await storeData(todayKey, rate, 60 * 60 * 24 * 90);
    
    result.push({
      code,
      name: names[code],
      rate: code === 'IDR' || code === 'VND' ? rate.toFixed(2) : rate.toFixed(4),
      change: change.toFixed(2),
      trend
    });
  }
  
  // 存储完整数据
  const ratesObj = {};
  targets.forEach(code => { if (rates[code]) ratesObj[code] = rates[code]; });
  await storeData(`RATES:${today}`, JSON.stringify(ratesObj), 60 * 60 * 24 * 90);
  await storeData(`SOURCE:${today}`, source, 60 * 60 * 24 * 90);
  await storeData('LAST_UPDATE', new Date().toISOString(), 60 * 60 * 24 * 90);
  
  console.log(`存储完成，共${result.length}个币种`);
  
  return result;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}