import { runAllTests } from './tests.js';
import { generateDailyReport } from './reports.js';
import cron from 'node-cron';

let testInterval;
let dailyReportTask;

export function startMonitoring(intervalMinutes = 5) {
  console.log(`Starting monitoring with ${intervalMinutes} minute intervals`);
  
  // Run tests immediately
  runAllTests().then(() => {
    // Schedule regular tests
    testInterval = cron.schedule(`*/${intervalMinutes} * * * *`, () => {
      console.log(`\n=== Scheduled test run at ${new Date().toLocaleString()} ===`);
      runAllTests();
    });
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
