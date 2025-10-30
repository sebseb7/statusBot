import { runAllTests } from './tests.js';
import { generateDailyReport } from './reports.js';
import { checkSystemHealth } from './system.js';
import cron from 'node-cron';

let testInterval;
let dailyReportTask;
let systemMonitorInterval;

export function startMonitoring(intervalMinutes = 5) {
  console.log(`Starting monitoring with ${intervalMinutes} minute intervals`);
  
  // Run tests immediately
  runAllTests().then(() => {
    // Schedule regular tests
    testInterval = cron.schedule(`*/${intervalMinutes} * * * *`, () => {
      if (process.env.LOG_VERBOSE === 'true') {
        console.log(`\n=== Scheduled test run at ${new Date().toLocaleString()} ===`);
      }
      runAllTests();
    });
  });
  
  // Start system monitoring (check every minute by default or as configured)
  const systemCheckIntervalMinutes = parseInt(process.env.SYSTEM_CHECK_INTERVAL_MINUTES) || 1;
  console.log(`Starting system monitoring with ${systemCheckIntervalMinutes} minute intervals`);
  
  // Initialize CPU baseline
  checkSystemHealth().then(() => {
    // After baseline is established, schedule regular checks
    setTimeout(() => {
      checkSystemHealth(); // First real check after baseline
      
      systemMonitorInterval = cron.schedule(`*/${systemCheckIntervalMinutes} * * * *`, () => {
        if (process.env.LOG_VERBOSE === 'true') {
          console.log(`\n=== System health check at ${new Date().toLocaleString()} ===`);
        }
        checkSystemHealth();
      });
    }, 2000); // Wait 2 seconds for CPU baseline
  });
  
  // Schedule daily report (9 AM by default)
  const reportHour = parseInt(process.env.DAILY_REPORT_HOUR) || 9;
  dailyReportTask = cron.schedule(`${reportHour} 0 * * *`, () => {
    console.log(`Generating daily report at ${new Date().toLocaleString()}`);
    generateDailyReport();
  });
  
  console.log(`Daily reports scheduled for ${reportHour}:00`);
}

export function stopMonitoring() {
  if (testInterval) {
    testInterval.stop();
  }
  if (systemMonitorInterval) {
    systemMonitorInterval.stop();
  }
  if (dailyReportTask) {
    dailyReportTask.stop();
  }
  console.log('Monitoring stopped');
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, stopping monitoring...');
  stopMonitoring();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, stopping monitoring...');
  stopMonitoring();
  process.exit(0);
});
