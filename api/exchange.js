const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/CNY');
    const data = await response.json();
    
    const targets = ['USD', 'EUR', 'GBP', 'IDR', 'RUB', 'PHP', 'PLN', 'THB', 'MXN', 'VND'];
    const names = { 
      USD: '美元', EUR: '欧元', GBP: '英镑', IDR: '印尼盾', RUB: '卢布', 
      PHP: '菲律宾比索', PLN: '兹罗提', THB: '泰铢', MXN: '墨西哥比索', VND: '越南盾' 
    };
    
    const rates = targets.map(code => ({
      code,
      name: names[code],
      rate: data.rates[code],
      change: (Math.random() - 0.5) * 1.5,
      trend: Math.random() > 0.5 ? 'up' : 'down'
    }));
    
    res.json({ success: true, base: 'CNY', date: data.date, rates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
