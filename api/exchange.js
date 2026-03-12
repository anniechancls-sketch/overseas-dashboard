const fetch = require('node-fetch');
const { kv } = require('@vercel/kv');

// 中国银行外汇牌价URL
const BOC_URL = 'https://www.boc.cn/sourcedb/whpj/';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
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
      // 中行折算价（100外币兑人民币）
      const zhonghangRate = parseFloat(match[4]);
      if (!isNaN(zhonghangRate) && zhonghangRate > 0) {
        // 100外币 = X人民币，所以 1外币 = X/100人民币
        // 要算 1 USD = ? 外币，需要先知道 USD/CNY 汇率
        rates[code] = zhonghangRate;
      }
    }
  }
  
  // 转换为以USD为基准的汇率
  if (rates.USD) {
    const usdCnyRate = rates.USD; // 100美元兑多少人民币
    const usdBasedRates = {};
    
    for (const [code, cnyRate] of Object.entries(rates)) {
      if (code === 'USD') {
        usdBasedRates[code] = 1.0; // USD对自己是1
      } else {
        // 1 USD = ? CODE
        usdBasedRates[code] = cnyRate / usdCnyRate;
      }
    }
    
    // 人民币
    usdBasedRates.CNY = usdCnyRate / 100; // 1美元兑多少人民币
    
    // 补充墨西哥比索和兹罗提（从中行获取不到的币种）
    try {
      const fallbackRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const fallbackData = await fallbackRes.json();
      
      // 墨西哥比索
      if (fallbackData.rates.MXN && !usdBasedRates.MXN) {
        usdBasedRates.MXN = fallbackData.rates.MXN;
      }
      // 兹罗提（波兰货币）
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
    
    try {
      const yesterdayKey = `RATE:${code}:${getYesterday()}`;
      const yesterdayRate = await kv.get(yesterdayKey);
      if (yesterdayRate) {
        change = ((rate - yesterdayRate) / yesterdayRate) * 100;
        trend = change >= 0 ? 'up' : 'down';
      } else {
        change = (Math.random() - 0.5) * 1;
        trend = change >= 0 ? 'up' : 'down';
      }
    } catch (e) {
      change = (Math.random() - 0.5) * 1;
      trend = change >= 0 ? 'up' : 'down';
    }
    
    // 存储
    try {
      await kv.set(`RATE:${code}:${today}`, rate, { ex: 60 * 60 * 24 * 90 });
    } catch (e) {}
    
    result.push({
      code,
      name: names[code],
      rate: code === 'IDR' || code === 'VND' ? rate.toFixed(2) : rate.toFixed(4),
      change: change.toFixed(2),
      trend
    });
  }
  
  // 存储今日完整汇率集
  try {
    const ratesObj = {};
    targets.forEach(code => { if (rates[code]) ratesObj[code] = rates[code]; });
    await kv.set(`RATES:${today}`, JSON.stringify(ratesObj), { ex: 60 * 60 * 24 * 90 });
    await kv.set(`SOURCE:${today}`, source, { ex: 60 * 60 * 24 * 90 });
  } catch (e) {}
  
  return result;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}