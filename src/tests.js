import net from 'net';
import { performance } from 'perf_hooks';
import db from './database.js';
import { sendToAllUsers } from './telegram.js';

const insertTestResult = db.prepare(`
  INSERT INTO tests (test_type, test_name, target, status, response_time, error_message, is_recovery)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getLastTestResult = db.prepare(`
  SELECT status, timestamp FROM tests 
  WHERE target = ? AND test_type = ? 
  ORDER BY timestamp DESC LIMIT 1
`);

export function parseTestConfig(configString) {
  const configs = configString.split(',').map(item => item.trim()).filter(item => item);
  const tests = [];
  
  for (const config of configs) {
    const parts = config.split('|').map(part => part.trim());
    
    if (parts.length === 2) {
      // Named test: "Name|target"
      const [name, target] = parts;
      tests.push({ name, target });
    } else {
      // Unnamed test: just target
      const target = parts[0];
      const name = target.split('/').pop() || target.split(':')[0] || target;
      tests.push({ name, target });
    }
  }
  
  return tests;
}

export async function runHttpTest(testConfig, timeout = 10000) {
  const { name, target: url } = testConfig;
  const startTime = performance.now();
  const testType = 'http';
  
  try {
    // Use native fetch with timeout and status handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      signal: controller.signal,
      method: 'GET',
      headers: {
        'User-Agent': 'StatusBot/1.0'
      }
    });
    
    clearTimeout(timeoutId);
    
    const responseTime = Math.round(performance.now() - startTime);
    const status = response.status < 400 ? 'success' : 'failed';
    const errorMessage = status === 'failed' ? `HTTP ${response.status}` : null;
    
    // Check if this is a recovery
    const lastResult = getLastTestResult.get(url, testType);
    const isRecovery = lastResult && lastResult.status === 'failed';
    
    // Explicit type conversion for SQLite binding
    insertTestResult.run(
      String(testType),
      String(name),
      String(url),
      String(status),
      Number(responseTime),
      errorMessage ? String(errorMessage) : null,
      isRecovery ? 1 : 0
    );
    
    if (status === 'failed' || isRecovery) {
      const message = isRecovery 
        ? `✅ <b>RECOVERY</b>: ${name} is back online (Response time: ${responseTime}ms)`
        : `❌ <b>HTTP TEST FAILED</b>: ${name} - ${errorMessage} (Response time: ${responseTime}ms)`;
      
      sendToAllUsers(message);
    }
    
    return { status, responseTime, errorMessage, name };
    
  } catch (error) {
    const responseTime = Math.round(performance.now() - startTime);
    let errorMessage;
    
    if (error.name === 'AbortError') {
      errorMessage = 'Request timeout';
    } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
      errorMessage = 'Network error - cannot reach server';
    } else {
      errorMessage = error.message || 'Unknown error';
    }
    
    const lastResult = getLastTestResult.get(url, testType);
    const isRecovery = false;
    
    // Explicit type conversion for SQLite binding
    insertTestResult.run(
      String(testType),
      String(name),
      String(url),
      'failed',
      Number(responseTime),
      String(errorMessage),
      0
    );
    
    const message = `❌ <b>HTTP TEST FAILED</b>: ${name} - ${errorMessage} (Response time: ${responseTime}ms)`;
    sendToAllUsers(message);
    
    return { status: 'failed', responseTime, errorMessage, name };
  }
}

export async function runTcpTest(testConfig, timeout = 5000) {
  const { name, target } = testConfig;
  const [host, port] = target.split(':');
  const startTime = performance.now();
  const testType = 'tcp';
  
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    
    const timer = setTimeout(() => {
      socket.destroy();
      const responseTime = Math.round(performance.now() - startTime);
      
      const lastResult = getLastTestResult.get(target, testType);
      const isRecovery = false;
      
      // Explicit type conversion for SQLite binding
      insertTestResult.run(
        String(testType),
        String(name),
        String(target),
        'failed',
        Number(responseTime),
        'Connection timeout',
        0
      );
      
      sendToAllUsers(`❌ <b>TCP TEST FAILED</b>: ${name} - Connection timeout (${responseTime}ms)`);
      resolve({ status: 'failed', responseTime, errorMessage: 'Connection timeout', name });
    }, timeout);
    
    socket.setTimeout(timeout);
    
    socket.connect(parseInt(port), host, () => {
      clearTimeout(timer);
      connected = true;
      socket.destroy();
      
      const responseTime = Math.round(performance.now() - startTime);
      
      const lastResult = getLastTestResult.get(target, testType);
      const isRecovery = lastResult && lastResult.status === 'failed';
      
      // Explicit type conversion for SQLite binding
      insertTestResult.run(
        String(testType),
        String(name),
        String(target),
        'success',
        Number(responseTime),
        null,
        isRecovery ? 1 : 0
      );
      
      if (isRecovery) {
        sendToAllUsers(`✅ <b>TCP RECOVERY</b>: ${name} is reachable (${responseTime}ms)`);
      }
      
      resolve({ status: 'success', responseTime, errorMessage: null, name });
    });
    
    socket.on('error', (error) => {
      clearTimeout(timer);
      const responseTime = Math.round(performance.now() - startTime);
      
      const lastResult = getLastTestResult.get(target, testType);
      const isRecovery = false;
      
      // Explicit type conversion for SQLite binding
      insertTestResult.run(
        String(testType),
        String(name),
        String(target),
        'failed',
        Number(responseTime),
        String(error.message || error.code),
        0
      );
      
      sendToAllUsers(`❌ <b>TCP TEST FAILED</b>: ${name} - ${error.message || error.code} (${responseTime}ms)`);
      resolve({ status: 'failed', responseTime, errorMessage: error.message || error.code, name });
    });
  });
}

export async function runAllTests() {
  console.log('Running all monitoring tests...');
  
  // Parse HTTP configurations
  let httpTests = [];
  if (process.env.HTTP_ENDPOINTS) {
    httpTests = parseTestConfig(process.env.HTTP_ENDPOINTS);
  } else {
    // Default tests with names
    httpTests = [
      { name: 'Test API', target: 'https://httpbin.org/status/200' },
      { name: 'GitHub API', target: 'https://api.github.com' }
    ];
  }
  
  // Parse TCP configurations
  let tcpTests = [];
  if (process.env.TCP_HOSTS) {
    tcpTests = parseTestConfig(process.env.TCP_HOSTS);
  } else {
    // Default tests with names
    tcpTests = [
      { name: 'Google Web', target: 'google.com:80' },
      { name: 'GitHub HTTPS', target: 'github.com:443' }
    ];
  }
  
  const results = [];
  
  // Run HTTP tests
  console.log(`\n🔗 Testing ${httpTests.length} HTTP endpoints:`);
  for (const testConfig of httpTests) {
    console.log(`  ${testConfig.name}: ${testConfig.target}`);
    const result = await runHttpTest(testConfig);
    results.push({ type: 'http', ...result });
  }
  
  // Run TCP tests
  console.log(`\n🌐 Testing ${tcpTests.length} TCP connections:`);
  for (const testConfig of tcpTests) {
    console.log(`  ${testConfig.name}: ${testConfig.target}`);
    const result = await runTcpTest(testConfig);
    results.push({ type: 'tcp', ...result });
  }
  
  console.log(`\n✅ Completed ${results.length} tests`);
  return results;
}
