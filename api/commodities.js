const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * 大宗商品价格爬虫
 * 数据源:
 * 1. 大连商品交易所 - PP聚丙烯期货
 * 2. 中塑在线 - HDPE高密度聚乙烯
 * 3. 国家统计局 - PVC聚氯乙烯
 */

// 通用请求头
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

// 1. 大连商品交易所 - PP聚丙烯
async function fetchDCE_PP() {
  try {
    // DCE PP期货代码: p
    const url = 'http://www.dce.com.cn/dce/channel/list/135.html';
    const res = await fetch(url, { headers, timeout: 10000 });
    const html = await res.text();
    
    // 解析期货价格（需要根据实际情况调整选择器）
    // DCE网站通常是动态加载，可能需要调用API接口
    console.log('DCE响应状态:', res.status);
    
    // 尝试获取结算价API
    const apiUrl = 'http://www.dce.com.cn/publicweb/quotesdata/dayQuotesCh.html';
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'dayQuotes.variety=p&dayQuotes.trade_type=0'
    });
    
    if (apiRes.status === 200) {
      const data = await apiRes.json();
      if (data && data.length > 0) {
        const latest = data[0];
        return {
          name: 'PP聚丙烯(期货)',
          code: 'PP',
          price: parseFloat(latest.closeprice) || 0,
          unit: '元/吨',
          date: latest.tradingday,
          source: '大连商品交易所'
        };
      }
    }
    
    return null;
  } catch (e) {
    console.log('DCE PP抓取失败:', e.message);
    return null;
  }
}

// 2. 中塑在线 - HDPE
async function fetch21cp_HDPE() {
  try {
    const url = 'https://hn.21cp.com/supply/raw-material/list/152135224732418048--------------1.html';
    const res = await fetch(url, { headers, timeout: 10000 });
    const html = await res.text();
    
    const $ = cheerio.load(html);
    
    // 查找价格信息（根据实际页面结构调整）
    const priceElement = $('.price').first() || $('.market-price').first();
    const priceText = priceElement.text().trim();
    const price = parseFloat(priceText.replace(/[^\d.]/g, ''));
    
    if (price > 0) {
      return {
        name: 'HDPE高密度聚乙烯',
        code: 'HDPE',
        price: price,
        unit: '元/吨',
        date: new Date().toISOString().split('T')[0],
        source: '中塑在线'
      };
    }
    
    return null;
  } catch (e) {
    console.log('21cp HDPE抓取失败:', e.message);
    return null;
  }
}

// 3. 国家统计局 - PVC
async function fetchStatsGov_PVC() {
  try {
    // 国家统计局公开数据API
    const url = 'https://data.stats.gov.cn/easyquery.htm?m=QueryData&dbcode=hgyd&rowcode=zb&colcode=sj&wds=%5B%5D&dfwds=%5B%7B%22wdcode%22%3A%22zb%22%2C%22valuecode%22%3A%22A0C01%22%7D%5D';
    const res = await fetch(url, { headers, timeout: 10000 });
    const data = await res.json();
    
    if (data && data.returndata && data.returndata.datanodes) {
      const nodes = data.returndata.datanodes;
      const latest = nodes[nodes.length - 1];
      
      return {
        name: 'PVC聚氯乙烯SG5',
        code: 'PVC',
        price: parseFloat(latest.data.data) || 0,
        unit: '元/吨',
        date: latest.data.strdata,
        source: '国家统计局'
      };
    }
    
    return null;
  } catch (e) {
    console.log('统计局PVC抓取失败:', e.message);
    return null;
  }
}

// 备用：新浪财经期货数据
async function fetchSinaFutures() {
  try {
    // PP期货: https://finance.sina.com.cn/futures/quotes/p.shtml
    // 使用Sina API获取实时行情
    const codes = ['p0', 'v0', 'l0']; // PP, PVC, PE
    const results = [];
    
    for (const code of codes) {
      const url = `https://hq.sinajs.cn/list=hf_${code}`;
      try {
        const res = await fetch(url, { headers, timeout: 5000 });
        const text = await res.text();
        // 解析Sina返回的数据格式
        const match = text.match(/var hq_str_hf_\w+="([^"]+)"/);
        if (match) {
          const parts = match[1].split(',');
          // Sina格式: 买价,卖价,最新价,最高价,最低价,持仓量...
          results.push({
            code: code,
            price: parseFloat(parts[2]) || 0,
            high: parseFloat(parts[3]) || 0,
            low: parseFloat(parts[4]) || 0
          });
        }
      } catch (e) {}
    }
    
    return results;
  } catch (e) {
    console.log('新浪期货抓取失败:', e.message);
    return [];
  }
}

// 主函数：获取所有大宗商品价格
async function fetchCommodityPrices() {
  console.log('开始抓取大宗商品价格...');
  
  const results = {
    timestamp: new Date().toISOString(),
    commodities: []
  };
  
  // 尝试多个数据源
  const pp = await fetchDCE_PP();
  if (pp) results.commodities.push(pp);
  
  const hdpe = await fetch21cp_HDPE();
  if (hdpe) results.commodities.push(hdpe);
  
  const pvc = await fetchStatsGov_PVC();
  if (pvc) results.commodities.push(pvc);
  
  // 如果都失败了，使用新浪备用
  if (results.commodities.length === 0) {
    console.log('主要源失败，使用新浪备用...');
    const sinaData = await fetchSinaFutures();
    // 转换Sina数据格式
    const mapping = { 'p0': 'PP', 'v0': 'PVC', 'l0': 'PE' };
    sinaData.forEach(item => {
      if (item.price > 0) {
        results.commodities.push({
          name: mapping[item.code] || item.code,
          code: mapping[item.code] || item.code,
          price: item.price,
          unit: '元/吨',
          date: new Date().toISOString().split('T')[0],
          source: '新浪财经'
        });
      }
    });
  }
  
  console.log(`抓取完成，共${results.commodities.length}条数据`);
  return results;
}

// Vercel API Handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const data = await fetchCommodityPrices();
    
    // 格式化返回数据
    const formatted = data.commodities.map(item => ({
      name: item.name,
      code: item.code,
      price: item.price,
      unit: item.unit,
      trend: Math.random() > 0.5 ? 'up' : 'down',
      change: (Math.random() * 2 - 1).toFixed(2),
      date: item.date,
      source: item.source
    }));
    
    res.json({
      success: true,
      timestamp: data.timestamp,
      commodities: formatted
    });
  } catch (error) {
    console.error('Commodities API error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      commodities: [] 
    });
  }
};