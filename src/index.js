import dotenv from 'dotenv';
import { initTelegram, sendMessage, sendToAllUsers } from './telegram.js';
import { startMonitoring } from './scheduler.js';
import { generateDailyReport } from './reports.js';
import { parseTestConfig } from './tests.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const sendStatus = args.includes('--status');
const sendReport = args.includes('--report');
const runMonitoring = !sendStatus && !sendReport;

async function main() {
  console.log('🚀 Starting Status Monitoring Bot');
  console.log(`📅 Date: ${new Date().toLocaleString()}`);
  
  // Validate environment variables
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is required in .env file');
    process.exit(1);
  }
  
  if (!process.env.TELEGRAM_CHAT_IDS) {
    console.error('❌ TELEGRAM_CHAT_IDS is required in .env file');
    console.log('Format: 123456789,987654321 (comma-separated chat IDs)');
    process.exit(1);
  }
  
  try {
    // Initialize Telegram bot
    console.log('📱 Initializing Telegram bot...');
    initTelegram(process.env.TELEGRAM_BOT_TOKEN);
    
    if (sendStatus) {
      console.log('📤 Sending status message to all users...');
      const statusMessage = `📊 <b>Status Check</b> (${new Date().toLocaleString()})\n\n🤖 Bot is running normally.\n⏱️ Current time: ${new Date().toLocaleString()}\n\nAll monitoring systems operational.`;
      await sendToAllUsers(statusMessage);
      console.log('✅ Status message sent successfully!');
      process.exit(0);
    }
    
    if (sendReport) {
      console.log('📊 Generating and sending daily report...');
      await generateDailyReport();
      console.log('✅ Daily report sent successfully!');
      process.exit(0);
    }
    
    if (runMonitoring) {
      // Parse configured tests for startup message
      let httpTests = [];
      if (process.env.HTTP_ENDPOINTS) {
        httpTests = parseTestConfig(process.env.HTTP_ENDPOINTS);
      } else {
        httpTests = [
          { name: 'Test API', target: 'https://httpbin.org/status/200' },
          { name: 'GitHub API', target: 'https://api.github.com' }
        ];
      }
      
      let tcpTests = [];
      if (process.env.TCP_HOSTS) {
        tcpTests = parseTestConfig(process.env.TCP_HOSTS);
      } else {
        tcpTests = [
          { name: 'Google Web', target: 'google.com:80' },
          { name: 'GitHub HTTPS', target: 'github.com:443' }
        ];
      }
      
      const totalHttpTests = httpTests.length;
      const totalTcpTests = tcpTests.length;
      const totalTests = totalHttpTests + totalTcpTests;
      
      const intervalMinutes = parseInt(process.env.TEST_INTERVAL_MINUTES) || 5;
      const reportHour = process.env.DAILY_REPORT_HOUR || 9;
      
      // Build detailed startup message
      let startupMessage = `🤖 <b>Status Bot Started</b>\n\n`;
      startupMessage += `⏰ Started: ${new Date().toLocaleString()}\n`;
      startupMessage += `👥 Users: ${process.env.TELEGRAM_CHAT_IDS.split(',').length}\n\n`;
      
      startupMessage += `📊 <b>Monitoring Configuration</b>\n`;
      startupMessage += `⏱️ Test Interval: ${intervalMinutes} minutes\n`;
      startupMessage += `📅 Daily Reports: ${reportHour}:00\n\n`;
      
      if (totalTests > 0) {
        startupMessage += `🔍 <b>Configured Tests</b> (${totalTests} total)\n\n`;
        
        if (totalHttpTests > 0) {
          startupMessage += `🌐 <b>HTTP Endpoints</b> (${totalHttpTests}):\n`;
          httpTests.forEach(test => {
            const displayTarget = test.target.length > 60 ? test.target.substring(0, 60) + '...' : test.target;
            startupMessage += `  • <b>${test.name}</b>: ${displayTarget}\n`;
          });
          startupMessage += `\n`;
        }
        
        if (totalTcpTests > 0) {
          startupMessage += `🔌 <b>TCP Connections</b> (${totalTcpTests}):\n`;
          tcpTests.forEach(test => {
            const displayTarget = test.target.length > 60 ? test.target.substring(0, 60) + '...' : test.target;
            startupMessage += `  • <b>${test.name}</b>: <code>${displayTarget}</code>\n`;
          });
        }
        
        startupMessage += `\n✅ All systems ready. Monitoring active!`;
      } else {
        startupMessage += `ℹ️ No custom tests configured. Using defaults.\n\n`;
        startupMessage += `🔍 <b>Default HTTP Tests</b> (2):\n`;
        startupMessage += `  • <b>Test API</b>: https://httpbin.org/status/200\n`;
        startupMessage += `  • <b>GitHub API</b>: https://api.github.com\n\n`;
        startupMessage += `🔌 <b>Default TCP Tests</b> (2):\n`;
        startupMessage += `  • <b>Google Web</b>: <code>google.com:80</code>\n`;
        startupMessage += `  • <b>GitHub HTTPS</b>: <code>github.com:443</code>\n\n`;
        startupMessage += `✅ All systems ready. Monitoring active!`;
      }
      
      // Send startup message only to the first chat ID
      const chatIds = process.env.TELEGRAM_CHAT_IDS.split(',').map(id => id.trim());
      const firstChatId = chatIds[0];
      if (firstChatId) {
        await new Promise((resolve) => {
          setTimeout(async () => {
            try {
              await sendMessage(firstChatId, startupMessage);
              console.log(`✅ Startup message sent to primary user (${firstChatId})`);
              resolve();
            } catch (error) {
              console.warn(`Failed to send startup message to ${firstChatId}: ${error.message}`);
              resolve();
            }
          }, 1000);
        });
      } else {
        console.warn('No valid chat IDs found for startup message');
      }
      
      // Start monitoring
      startMonitoring(intervalMinutes);
      
      console.log(`✅ Bot started successfully!`);
      console.log(`⏱️  Test interval: ${intervalMinutes} minutes`);
      console.log(`📊 Daily reports: ${reportHour}:00`);
      console.log(`\n💡 Tip: Check the database file "status_bot.db" for test results`);
      console.log(`\n📤 CLI Commands:`);
      console.log(`  • Send status: node src/index.js --status`);
      console.log(`  • Send report: node src/index.js --report`);
      console.log(`\nPress Ctrl+C to stop the bot gracefully.\n`);
    }
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Run the application
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
