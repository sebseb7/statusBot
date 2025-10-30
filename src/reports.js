import db from './database.js';
import puppeteer from 'puppeteer';
import { sendToAllUsers, sendPhoto } from './telegram.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getDailyStats = db.prepare(`
  SELECT 
    test_type,
    test_name,
    target,
    COUNT(*) as total_tests,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tests,
    AVG(response_time) as avg_response_time,
    MIN(response_time) as min_response_time,
    MAX(response_time) as max_response_time
  FROM tests 
  WHERE DATE(timestamp) = DATE('now')
  GROUP BY test_type, test_name, target
  ORDER BY test_type, test_name
`);

const getSummaryStats = db.prepare(`
  SELECT 
    COUNT(*) as total_tests,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tests,
    AVG(response_time) as avg_response_time,
    COUNT(DISTINCT test_name) as unique_tests
  FROM tests 
  WHERE DATE(timestamp) = DATE('now')
`);

const getSystemStats = db.prepare(`
  SELECT 
    AVG(cpu_usage) as avg_cpu,
    MAX(cpu_usage) as max_cpu,
    AVG(ram_usage_percent) as avg_ram,
    MAX(ram_usage_percent) as max_ram,
    MAX(ram_total_mb) as total_ram_mb,
    AVG(disk_usage_percent) as avg_disk,
    MAX(disk_usage_percent) as max_disk,
    MIN(disk_usage_percent) as min_disk,
    MAX(disk_total_gb) as total_disk_gb,
    COUNT(CASE WHEN status = 'warning' THEN 1 END) as warning_count,
    COUNT(CASE WHEN status = 'critical' THEN 1 END) as critical_count
  FROM system_metrics 
  WHERE DATE(timestamp) = DATE('now')
`);

export async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get summary statistics
  const summary = getSummaryStats.get();
  const details = getDailyStats.all();
  const systemStats = getSystemStats.get();
  
  if (!summary || summary.total_tests === 0) {
    const message = `📊 <b>Daily Monitoring Report</b> (${today})\n\nℹ️ No test data available for today.\n\nMonitoring is active but no tests have run yet. First report will appear tomorrow.`;
    await sendToAllUsers(message);
    console.log('No test data available for today');
    return;
  }
  
  const successRate = ((summary.total_tests - summary.failed_tests) / summary.total_tests * 100).toFixed(1);
  const avgResponseTime = Math.round(summary.avg_response_time || 0);
  const failureRate = (summary.failed_tests / summary.total_tests * 100).toFixed(1);
  
  // Determine overall status color
  const overallStatus = successRate >= 90 ? 'good' : successRate >= 80 ? 'warning' : 'critical';
  
  // Generate report message (text summary)
  let message = `📊 <b>Daily Monitoring Report</b> (${today})\n\n`;
  message += `📈 <b>Summary</b>\n`;
  message += `• Total Tests: ${summary.total_tests}\n`;
  message += `• Failed Tests: ${summary.failed_tests} (${failureRate}%)\n`;
  message += `• Success Rate: <b>${successRate}%</b> ${getStatusEmoji(overallStatus)}\n`;
  message += `• Avg Response Time: ${avgResponseTime}ms\n`;
  message += `• Unique Services: ${summary.unique_tests}\n\n`;
  
  // Add system metrics if available
  if (systemStats && systemStats.avg_cpu !== null) {
    message += `🖥️ <b>System Resources</b>\n`;
    message += `• Avg CPU: ${Math.round(systemStats.avg_cpu || 0)}% (Peak: ${Math.round(systemStats.max_cpu || 0)}%)\n`;
    message += `• Avg RAM: ${Math.round(systemStats.avg_ram || 0)}% (Peak: ${Math.round(systemStats.max_ram || 0)}%)\n`;
    
    if (systemStats.avg_disk !== null && systemStats.total_disk_gb) {
      const avgDiskUsedGB = Math.round((systemStats.avg_disk / 100) * systemStats.total_disk_gb);
      const maxDiskUsedGB = Math.round((systemStats.max_disk / 100) * systemStats.total_disk_gb);
      message += `• Avg Disk: ${Math.round(systemStats.avg_disk || 0)}% (Peak: ${Math.round(systemStats.max_disk || 0)}% - ${systemStats.total_disk_gb - maxDiskUsedGB}GB free)\n`;
    }
    
    if (systemStats.warning_count > 0 || systemStats.critical_count > 0) {
      message += `• Alerts: `;
      if (systemStats.critical_count > 0) {
        message += `🔴 ${systemStats.critical_count} critical`;
      }
      if (systemStats.warning_count > 0) {
        if (systemStats.critical_count > 0) message += `, `;
        message += `⚠️ ${systemStats.warning_count} warning`;
      }
      message += `\n`;
    }
    message += `\n`;
  }
  
  message += `🔍 <b>Service Status</b>\n`;
  details.forEach(row => {
    const rowSuccessRate = ((row.total_tests - row.failed_tests) / row.total_tests * 100).toFixed(1);
    const rowStatus = rowSuccessRate >= 90 ? 'good' : rowSuccessRate >= 80 ? 'warning' : 'critical';
    message += `• <b>${row.test_name}</b> (${row.test_type.toUpperCase()})\n`;
    message += `  └ ${getStatusEmoji(rowStatus)} ${rowSuccessRate}% success | ${Math.round(row.avg_response_time || 0)}ms avg\n`;
  });
  
  // Generate HTML chart
  const chartPath = await createDailyChart(details, summary, today, overallStatus, systemStats);
  
  // Send text report
  await sendToAllUsers(message);
  
  // Send chart image
  if (chartPath) {
    const chatIds = process.env.TELEGRAM_CHAT_IDS.split(',').map(id => id.trim());
    for (const chatId of chatIds) {
      if (chatId) {
        await sendPhoto(chatId, chartPath, `📉 Daily Performance Overview (${today}) - ${overallStatus.toUpperCase()}`);
      }
    }
  }
  
  // Save summary to database
  const insertSummary = db.prepare(`
    INSERT INTO daily_summaries (date, total_tests, failed_tests, avg_response_time, summary_image)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  insertSummary.run(today, summary.total_tests, summary.failed_tests, avgResponseTime, chartPath || null);
  
  console.log(`Daily report sent for ${today} (${overallStatus.toUpperCase()})`);
  return { message, chartPath, overallStatus };
}

function getStatusEmoji(status) {
  switch (status) {
    case 'good': return '🟢';
    case 'warning': return '🟡';
    case 'critical': return '🔴';
    default: return '⚪';
  }
}

async function createDailyChart(data, summary, date, overallStatus, systemStats) {
  try {
    if (!summary || summary.total_tests === 0) {
      return null;
    }
    
    const successRate = ((summary.total_tests - summary.failed_tests) / summary.total_tests * 100);
    
    // Generate HTML content
    const htmlContent = generateReportHTML(data, summary, date, successRate, overallStatus, systemStats);
    
    // Ensure reports directory exists
    const reportsDir = path.join(__dirname, '../reports');
    await fs.mkdir(reportsDir, { recursive: true });
    
    // Write to temporary file
    const tempHtmlPath = path.join(reportsDir, `temp_report_${date}.html`);
    await fs.writeFile(tempHtmlPath, htmlContent);
    
    // Launch Puppeteer
    const browser = await puppeteer.launch({ 
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 800 });
    
    // Load and screenshot
    await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle0' });
    const chartPath = path.join(reportsDir, `daily_report_${date}.png`);
    await page.screenshot({ path: chartPath, fullPage: true });
    
    // Cleanup
    await browser.close();
    await fs.unlink(tempHtmlPath);
    
    return chartPath;
    
  } catch (error) {
    console.error('Failed to generate daily chart with Puppeteer:', error);
    return null;
  }
}

function generateReportHTML(data, summary, date, successRate, overallStatus, systemStats) {
  const httpData = data.filter(d => d.test_type === 'http');
  const tcpData = data.filter(d => d.test_type === 'tcp');
  
  // Gauge CSS (conic gradient for circular progress)
  const gaugeStyle = successRate >= 90 ? 'conic-gradient(green 0deg, green ' + (successRate * 3.6) + 'deg, #ddd ' + (successRate * 3.6) + 'deg 360deg)' 
                      : successRate >= 80 ? 'conic-gradient(#f39c12 0deg, #f39c12 ' + (successRate * 3.6) + 'deg, #ddd ' + (successRate * 3.6) + 'deg 360deg)' 
                      : 'conic-gradient(red 0deg, red ' + (successRate * 3.6) + 'deg, #ddd ' + (successRate * 3.6) + 'deg 360deg)';
  
  const statusColor = overallStatus === 'good' ? '#27ae60' : overallStatus === 'warning' ? '#f39c12' : '#e74c3c';
  
  let serviceBars = '';
  
  // HTTP Services
  if (httpData.length > 0) {
    serviceBars += `<div class="section"><h3>HTTP Services</h3>`;
    httpData.forEach(item => {
      const successPct = ((item.total_tests - item.failed_tests) / item.total_tests) * 100;
      const failPct = 100 - successPct;
      const statusClass = successPct >= 90 ? 'good' : successPct >= 80 ? 'warning' : 'critical';
      const displayName = item.test_name.length > 20 ? item.test_name.substring(0, 20) + '...' : item.test_name;
      
      serviceBars += `
        <div class="service-bar">
          <div class="service-info">
            <span class="service-name ${statusClass}">${displayName}</span>
            <span class="test-count">(${item.total_tests}t)</span>
          </div>
          <div class="bar-container">
            <div class="success-bar" style="width: ${successPct}%"></div>
            ${failPct > 0 ? `<div class="fail-bar" style="width: ${failPct}%"></div>` : ''}
          </div>
          <div class="metrics">
            <span class="success-pct">${Math.round(successPct)}%</span>
            <span class="response-time">${Math.round(item.avg_response_time || 0)}ms</span>
          </div>
        </div>
      `;
    });
    serviceBars += '</div>';
  }
  
  // TCP Services
  if (tcpData.length > 0) {
    serviceBars += `<div class="section"><h3>TCP Services</h3>`;
    tcpData.forEach(item => {
      const successPct = ((item.total_tests - item.failed_tests) / item.total_tests) * 100;
      const failPct = 100 - successPct;
      const statusClass = successPct >= 90 ? 'good' : successPct >= 80 ? 'warning' : 'critical';
      const displayName = item.test_name.length > 20 ? item.test_name.substring(0, 20) + '...' : item.test_name;
      
      serviceBars += `
        <div class="service-bar">
          <div class="service-info">
            <span class="service-name ${statusClass}">${displayName}</span>
            <span class="test-count">(${item.total_tests}t)</span>
          </div>
          <div class="bar-container">
            <div class="success-bar" style="width: ${successPct}%"></div>
            ${failPct > 0 ? `<div class="fail-bar" style="width: ${failPct}%"></div>` : ''}
          </div>
          <div class="metrics">
            <span class="success-pct">${Math.round(successPct)}%</span>
            <span class="response-time">${Math.round(item.avg_response_time || 0)}ms</span>
          </div>
        </div>
      `;
    });
    serviceBars += '</div>';
  }
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Monitoring Report</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      padding: 20px;
      min-height: 800px;
      color: #333;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .header p {
      font-size: 16px;
      opacity: 0.9;
    }
    .gauge-section {
      padding: 40px 30px;
      text-align: center;
      background: #f8f9fa;
    }
    .gauge-container {
      position: relative;
      display: inline-block;
      margin: 20px 0;
    }
    .gauge {
      width: 200px;
      height: 200px;
      border-radius: 50%;
      background: ${gaugeStyle};
      position: relative;
      margin: 0 auto;
    }
    .gauge::before {
      content: '';
      position: absolute;
      top: 20px;
      left: 20px;
      right: 20px;
      bottom: 20px;
      background: white;
      border-radius: 50%;
      z-index: 1;
    }
    .gauge-center {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2;
      font-size: 36px;
      font-weight: bold;
      color: ${statusColor};
    }
    .gauge-label {
      margin-top: 10px;
      font-size: 18px;
      font-weight: 600;
      color: #555;
    }
    .summary {
      padding: 30px;
      background: white;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      border-bottom: 1px solid #eee;
    }
    .summary-item {
      text-align: center;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 10px;
    }
    .summary-item h3 {
      font-size: 24px;
      font-weight: bold;
      color: ${statusColor};
      margin-bottom: 5px;
    }
    .summary-item p {
      color: #666;
      font-size: 14px;
    }
    .services-section {
      padding: 30px;
    }
    .section {
      margin-bottom: 40px;
    }
    .section h3 {
      font-size: 20px;
      font-weight: 600;
      color: #2c3e50;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 2px solid #eee;
    }
    .service-bar {
      display: flex;
      align-items: center;
      margin-bottom: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 10px;
      transition: box-shadow 0.2s;
    }
    .service-bar:hover {
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    }
    .service-info {
      flex: 1;
      min-width: 200px;
    }
    .service-name {
      font-weight: 600;
      font-size: 16px;
      margin-right: 10px;
    }
    .service-name.good { color: #27ae60; }
    .service-name.warning { color: #f39c12; }
    .service-name.critical { color: #e74c3c; }
    .test-count {
      font-size: 14px;
      color: #666;
    }
    .bar-container {
      flex: 2;
      height: 20px;
      background: #e0e0e0;
      border-radius: 10px;
      overflow: hidden;
      margin: 0 20px;
      position: relative;
    }
    .success-bar {
      height: 100%;
      background: linear-gradient(90deg, #27ae60, #2ecc71);
      transition: width 0.3s ease;
    }
    .fail-bar {
      height: 100%;
      background: linear-gradient(90deg, #e74c3c, #c0392b);
      position: absolute;
      right: 0;
      top: 0;
    }
    .metrics {
      flex: 1;
      text-align: right;
      min-width: 150px;
    }
    .success-pct {
      font-weight: bold;
      font-size: 18px;
      color: #2c3e50;
      display: block;
    }
    .response-time {
      font-size: 14px;
      color: #666;
      display: block;
    }
    .footer {
      padding: 20px 30px;
      background: #f8f9fa;
      text-align: center;
      color: #666;
      font-size: 14px;
      border-top: 1px solid #eee;
    }
    @media (max-width: 768px) {
      .service-bar {
        flex-direction: column;
        align-items: flex-start;
      }
      .bar-container {
        width: 100%;
        margin: 10px 0;
      }
      .metrics {
        text-align: left;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Daily Monitoring Report</h1>
      <p>${date}</p>
    </div>
    
    <div class="gauge-section">
      <div class="gauge-container">
        <div class="gauge"></div>
        <div class="gauge-center">${Math.round(successRate)}%</div>
        <div class="gauge-label">Overall Success Rate</div>
      </div>
    </div>
    
    <div class="summary">
      <div class="summary-item">
        <h3>${summary.total_tests}</h3>
        <p>Total Tests</p>
      </div>
      <div class="summary-item">
        <h3 style="color: #e74c3c;">${summary.failed_tests}</h3>
        <p>Failed Tests</p>
      </div>
      <div class="summary-item">
        <h3 style="color: ${statusColor};">${Math.round(successRate)}%</h3>
        <p>Success Rate</p>
      </div>
      <div class="summary-item">
        <h3>${Math.round(summary.avg_response_time || 0)}ms</h3>
        <p>Avg Response Time</p>
      </div>
      ${systemStats && systemStats.avg_cpu !== null ? `
      <div class="summary-item">
        <h3>${Math.round(systemStats.avg_cpu || 0)}%</h3>
        <p>Avg CPU Usage</p>
      </div>
      <div class="summary-item">
        <h3>${Math.round(systemStats.avg_ram || 0)}%</h3>
        <p>Avg RAM Usage</p>
      </div>
      ${systemStats.avg_disk !== null ? `
      <div class="summary-item">
        <h3>${Math.round(systemStats.avg_disk || 0)}%</h3>
        <p>Avg Disk Usage</p>
      </div>
      ` : ''}
      ` : ''}
    </div>
    
    <div class="services-section">
      ${serviceBars}
    </div>
    
    <div class="footer">
      Generated on ${new Date().toLocaleString()} | Monitoring ${summary.unique_tests} services
    </div>
  </div>
</body>
</html>`;
}
