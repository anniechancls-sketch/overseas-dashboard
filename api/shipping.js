module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // 模拟海运费数据（实际可接入SCFI或FBX API）
  const shippingData = {
    labels: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    datasets: [
      {
        label: '中国-北美',
        data: [3200, 3350, 3100, 2980, 3150, 3400, 3650, 3800, 4200, 3900, 3700, 3500]
      },
      {
        label: '中国-欧洲',
        data: [2800, 2950, 2700, 2650, 2800, 3100, 3400, 3600, 3900, 3700, 3500, 3300]
      },
      {
        label: '中国-东南亚',
        data: [800, 850, 780, 820, 900, 950, 1000, 1100, 1050, 980, 920, 880]
      }
    ]
  };
  
  res.json({ success: true, data: shippingData });
};
