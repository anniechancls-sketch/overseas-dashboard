const fetch = require('node-fetch');

const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://finance.sina.com.cn/'
};

// 动态找活跃合约（尝试当月起未来6个月）
async function findActiveContract(base) {
  const now = new Date();
  for (let i = 0; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = d.getFullYear().toString().slice(2);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const code = `${base}${year}${month}`;
    
    try {
      const res = await fetch(`https://hq.sinajs.cn/list=${code}`, {
        headers: SINA_HEADERS, timeout: 5000
      });
      const text = await res.text();
      const match = text.match(/"([^"]+)"/);
      if (match && match[1] && match[1].length > 20) {
        const parts = match[1].split(',');
        const price = parseFloat(parts[8]) || parseFloat(parts[3]) || 0;
        if (price > 0) {
          console.log(`${base} 活跃合约: ${code}, 价格: ${price}`);
          return { code, parts };
        }
      }
    } catch (e) {}
  }
  return null;
}

// 解析期货数据
function parseFuturesData(parts, contractName, displayName, unit, type) {
  const prevClose = parseFloat(parts[2]) || 0;
  const open = parseFloat(parts[3]) || 0;
  const high = parseFloat(parts[4]) || 0;
  const low = parseFloat(parts[5]) || 0;
  const latest = parseFloat(parts[8]) || open || 0;
  
  if (!latest) return null;
  
  const change = prevClose > 0 ? latest - prevClose : 0;
  const changePct = prevClose > 0 ? (change / prevClose * 100) : 0;
  
  return {
    name: displayName, code: contractName, type,
    price: latest, unit,
    prevClose, high, low,
    change: changePct.toFixed(2),
    trend: change >= 0 ? 'up' : 'down',
    source: '新浪财经期货',
    date: new Date().toISOString().split('T')[0]
  };
}

// 解析布伦特原油
async function fetchBrentOil() {
  try {
    const res = await fetch('https://hq.sinajs.cn/list=hf_OIL', {
      headers: SINA_HEADERS, timeout: 5000
    });
    const text = await res.text();
    const match = text.match(/"([^"]+)"/);
    if (!match || !match[1]) return null;
    
    const parts = match[1].split(',');
    // 原油格式: 买价,卖价,最新,最高,最低,...,昨收,...
    const latest = parseFloat(parts[0]) || parseFloat(parts[2]) || 0;
    const prevClose = parseFloat(parts[6]) || parseFloat(parts[7]) || 0;
    const high = parseFloat(parts[3]) || 0;
    const low = parseFloat(parts[4]) || 0;
    
    if (!latest) return null;
    
    const change = prevClose > 0 ? latest - prevClose : 0;
    const changePct = prevClose > 0 ? (change / prevClose * 100) : 0;
    
    return {
      name: '布伦特原油', code: 'BRENT', type: 'energy',
      price: latest, unit: '美元/桶',
      prevClose, high, low,
      change: changePct.toFixed(2),
      trend: change >= 0 ? 'up' : 'down',
      source: '新浪财经',
      date: new Date().toISOString().split('T')[0]
    };
  } catch (e) {
    console.log('原油获取失败:', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const commodities = [];
    
    // 并发查找所有活跃合约
    const [ppResult, pvcResult, peResult, cuResult, oil] = await Promise.all([
      findActiveContract('PP'),
      findActiveContract('V'),
      findActiveContract('L'),
      findActiveContract('CU'),
      fetchBrentOil()
    ]);
    
    // PP聚丙烯
    if (ppResult) {
      const data = parseFuturesData(ppResult.parts, 'PP', 'PP聚丙烯', '元/吨', 'chemical');
      if (data) commodities.push({ ...data, contract: ppResult.code });
    }
    
    // PVC聚氯乙烯
    if (pvcResult) {
      const data = parseFuturesData(pvcResult.parts, 'PVC', 'PVC聚氯乙烯SG5', '元/吨', 'chemical');
      if (data) commodities.push({ ...data, contract: pvcResult.code });
    }
    
    // PE高密度聚乙烯
    if (peResult) {
      const data = parseFuturesData(peResult.parts, 'PE', 'PE高密度聚乙烯', '元/吨', 'chemical');
      if (data) commodities.push({ ...data, contract: peResult.code });
    }
    
    // 铜
    if (cuResult) {
      const data = parseFuturesData(cuResult.parts, 'CU', '铜', '元/吨', 'metal');
      if (data) commodities.push({ ...data, contract: cuResult.code });
    }
    
    // 布伦特原油
    if (oil) commodities.push(oil);
    
    console.log(`成功获取${commodities.length}个商品数据`);
    
    res.json({
      success: true,
      source: '新浪财经期货',
      date: new Date().toISOString().split('T')[0],
      commodities
    });
    
  } catch (error) {
    console.error('Commodities error:', error);
    res.status(500).json({ success: false, error: error.message, commodities: [] });
  }
};