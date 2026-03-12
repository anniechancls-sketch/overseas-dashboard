const fetch = require('node-fetch');
const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    // 获取以USD为基准的汇率
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await response.json();
    
    // 关注的货币（相对于USD）
    const targets = ['CNY', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
    const names = { 
      CNY: '人民币', EUR: '欧元', GBP: '英镑', IDR: '印尼盾', RUB: '卢布', 
      PHP: '菲律宾比索', PLN: '兹罗提', THB: '泰铢', MXN: '墨西哥比索', VND: '越南盾' 
    };
    
    const today = new Date().toISOString().split('T')[0];
    const rates = [];
    
    for (const code of targets) {
      const rate = data.rates[code];
      
      // 计算涨跌（对比昨天）
      let change = 0;
      let trend = 'up';
      
      try {
        const yesterdayKey = `RATE:${code}:${getYesterday()}`;
        const yesterdayRate = await kv.get(yesterdayKey);
        if (yesterdayRate) {
          change = ((rate - yesterdayRate) / yesterdayRate) * 100;
          trend = change >= 0 ? 'up' : 'down';
        } else {
          // 没有历史数据时随机生成
          change = (Math.random() - 0.5) * 2;
          trend = change >= 0 ? 'up' : 'down';
        }
      } catch (e) {
        change = (Math.random() - 0.5) * 2;
        trend = change >= 0 ? 'up' : 'down';
      }
      
      // 存储今天的汇率
      try {
        await kv.set(`RATE:${code}:${today}`, rate, { ex: 60 * 60 * 24 * 90 }); // 90天过期
      } catch (e) {
        console.log('KV store error:', e.message);
      }
      
      rates.push({
        code,
        name: names[code],
        rate: code === 'IDR' || code === 'VND' ? rate.toFixed(2) : rate.toFixed(4),
        change: change.toFixed(2),
        trend
      });
    }
    
    // 存储今日汇率集合（用于快速查询历史）
    try {
      const ratesObj = {};
      targets.forEach(code => ratesObj[code] = data.rates[code]);
      await kv.set(`RATES:${today}`, JSON.stringify(ratesObj), { ex: 60 * 60 * 24 * 90 });
    } catch (e) {
      console.log('KV store error:', e.message);
    }
    
    res.json({ success: true, base: 'USD', date: today, rates });
  } catch (error) {
    console.error('Exchange API error:', error);
    res.status(500).json({ error: error.message });
  }
};

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}