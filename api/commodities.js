const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // 由于免费API限制，这里返回模拟但合理的数据
  // 实际生产环境可以接入Yahoo Finance或大宗商品的API
  const commodities = [
    { name: '布伦特原油', icon: '🛢️', unit: 'USD/桶', price: 78.45, change: 2.3, trend: 'up', type: 'oil' },
    { name: 'PVC SG5', icon: '🔧', unit: 'CNY/吨', price: 5870, change: -1.2, trend: 'down', type: 'pvc' },
    { name: 'PP聚丙烯', icon: '⚗️', unit: 'CNY/吨', price: 7520, change: 0.8, trend: 'up', type: 'pp' },
    { name: 'PE100', icon: '🔩', unit: 'CNY/吨', price: 8450, change: -0.5, trend: 'down', type: 'pe' },
    { name: '铜', icon: '⚡', unit: 'USD/吨', price: 8945, change: 1.5, trend: 'up', type: 'copper' }
  ];
  
  res.json({ success: true, date: new Date().toISOString().split('T')[0], commodities });
};
