import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../status_bot.db');

const db = new Database(dbPath);

// Check if database needs migration (old schema without test_name)
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tests'").all();
if (tables.length > 0) {
  const columns = db.prepare("PRAGMA table_info(tests)").all();
  const hasTestName = columns.some(col => col.name === 'test_name');
  
  if (!hasTestName) {
    // Migrate existing table - add test_name column and populate with target values
    db.exec('ALTER TABLE tests ADD COLUMN test_name TEXT NOT NULL DEFAULT ""');
    
    // Update existing records with target as name
    db.exec(`
      UPDATE tests 
      SET test_name = CASE 
        WHEN test_type = 'http' THEN 
          COALESCE(
            substr(target, instr(target, '//') + 2, instr(substr(target, instr(target, '//') + 2), '/') - 1),
            substr(target, instr(target, '/') + 1),
            target
          )
        ELSE 
          substr(target, 1, instr(target, ':') - 1)
      END
      WHERE test_name = ''
    `);
    
    console.log('✅ Database migrated: Added test_name column and populated existing records');
  }
}

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_type TEXT NOT NULL,
    test_name TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    response_time INTEGER,
    error_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_recovery BOOLEAN DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    total_tests INTEGER,
    failed_tests INTEGER,
    avg_response_time REAL,
    summary_image TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tests_timestamp ON tests(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tests_target ON tests(target);
  CREATE INDEX IF NOT EXISTS idx_tests_name ON tests(test_name);

  CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpu_usage REAL NOT NULL,
    ram_used_mb INTEGER NOT NULL,
    ram_total_mb INTEGER NOT NULL,
    ram_usage_percent INTEGER NOT NULL,
    disk_used_gb INTEGER,
    disk_total_gb INTEGER,
    disk_usage_percent INTEGER,
    status TEXT NOT NULL,
    warning_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp);
  CREATE INDEX IF NOT EXISTS idx_system_metrics_status ON system_metrics(status);
`);

export default db;
