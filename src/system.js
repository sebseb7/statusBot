import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import db from './database.js';
import { sendToAllUsers } from './telegram.js';

const execPromise = promisify(exec);

const insertSystemMetric = db.prepare(`
  INSERT INTO system_metrics (cpu_usage, ram_used_mb, ram_total_mb, ram_usage_percent, disk_used_gb, disk_total_gb, disk_usage_percent, status, warning_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getLastSystemStatus = db.prepare(`
  SELECT status, timestamp FROM system_metrics 
  ORDER BY timestamp DESC LIMIT 1
`);

// Configurable thresholds
const RAM_WARNING_THRESHOLD = parseInt(process.env.RAM_WARNING_THRESHOLD) || 85; // Percentage
const RAM_CRITICAL_THRESHOLD = parseInt(process.env.RAM_CRITICAL_THRESHOLD) || 95; // Percentage
const CPU_WARNING_THRESHOLD = parseInt(process.env.CPU_WARNING_THRESHOLD) || 80; // Percentage
const CPU_CRITICAL_THRESHOLD = parseInt(process.env.CPU_CRITICAL_THRESHOLD) || 90; // Percentage
const DISK_WARNING_THRESHOLD = parseInt(process.env.DISK_WARNING_THRESHOLD) || 85; // Percentage
const DISK_CRITICAL_THRESHOLD = parseInt(process.env.DISK_CRITICAL_THRESHOLD) || 95; // Percentage

// Track CPU for delta calculation
let previousCpuInfo = null;

function getCpuUsage() {
  const cpus = os.cpus();
  
  let totalIdle = 0;
  let totalTick = 0;
  
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  
  if (!previousCpuInfo) {
    previousCpuInfo = { idle, total };
    return null; // Need two measurements for accurate calculation
  }
  
  const idleDifference = idle - previousCpuInfo.idle;
  const totalDifference = total - previousCpuInfo.total;
  const cpuPercentage = 100 - ~~(100 * idleDifference / totalDifference);
  
  previousCpuInfo = { idle, total };
  
  return Math.max(0, Math.min(100, cpuPercentage)); // Clamp between 0-100
}

function getRamUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  const totalMemMB = Math.round(totalMem / 1024 / 1024);
  const usedMemMB = Math.round(usedMem / 1024 / 1024);
  const usagePercent = Math.round((usedMem / totalMem) * 100);
  
  return {
    totalMemMB,
    usedMemMB,
    usagePercent,
    freeMem: totalMemMB - usedMemMB
  };
}

async function getDiskUsage() {
  try {
    // Use df command to get disk usage for root mount
    const { stdout } = await execPromise('df -BG / | tail -1');
    
    // Parse df output: Filesystem Size Used Avail Use% Mounted
    const parts = stdout.trim().split(/\s+/);
    
    if (parts.length >= 5) {
      // Remove 'G' suffix and parse
      const totalGB = parseInt(parts[1].replace('G', ''));
      const usedGB = parseInt(parts[2].replace('G', ''));
      const availGB = parseInt(parts[3].replace('G', ''));
      const usagePercent = parseInt(parts[4].replace('%', ''));
      
      return {
        totalGB,
        usedGB,
        availGB,
        usagePercent
      };
    }
    
    // Fallback: return undefined if parsing failed
    return undefined;
    
  } catch (error) {
    console.warn('Failed to get disk usage:', error.message);
    return undefined;
  }
}

export async function checkSystemHealth() {
  try {
    // Get CPU usage
    const cpuUsage = getCpuUsage();
    
    // Get RAM usage
    const ramInfo = getRamUsage();
    
    // Get Disk usage
    const diskInfo = await getDiskUsage();
    
    // First run - need to establish baseline for CPU
    if (cpuUsage === null) {
      console.log('⏳ Establishing CPU baseline...');
      return { status: 'initializing' };
    }
    
    // Determine status
    let status = 'healthy';
    let warnings = [];
    
    // Check RAM
    if (ramInfo.usagePercent >= RAM_CRITICAL_THRESHOLD) {
      status = 'critical';
      warnings.push(`RAM critically low: ${ramInfo.usagePercent}% used (${ramInfo.usedMemMB}MB / ${ramInfo.totalMemMB}MB)`);
    } else if (ramInfo.usagePercent >= RAM_WARNING_THRESHOLD) {
      status = 'warning';
      warnings.push(`RAM usage high: ${ramInfo.usagePercent}% used (${ramInfo.usedMemMB}MB / ${ramInfo.totalMemMB}MB)`);
    }
    
    // Check CPU
    if (cpuUsage >= CPU_CRITICAL_THRESHOLD) {
      status = status === 'critical' ? 'critical' : 'critical';
      warnings.push(`CPU critically high: ${cpuUsage}%`);
    } else if (cpuUsage >= CPU_WARNING_THRESHOLD) {
      status = status === 'critical' ? 'critical' : 'warning';
      warnings.push(`CPU usage high: ${cpuUsage}%`);
    }
    
    // Check Disk (if available)
    if (diskInfo) {
      if (diskInfo.usagePercent >= DISK_CRITICAL_THRESHOLD) {
        status = 'critical';
        warnings.push(`Disk storage critically low: ${diskInfo.usagePercent}% used (${diskInfo.availGB}GB free)`);
      } else if (diskInfo.usagePercent >= DISK_WARNING_THRESHOLD) {
        status = status === 'critical' ? 'critical' : 'warning';
        warnings.push(`Disk storage low: ${diskInfo.usagePercent}% used (${diskInfo.availGB}GB free)`);
      }
    }
    
    const warningMessage = warnings.length > 0 ? warnings.join('; ') : null;

    // Check previous status to determine if we should alert
    const lastStatus = getLastSystemStatus.get();
    const statusChanged = !lastStatus || lastStatus.status !== status;

    console.log(`🔍 Status check: current=${status}, previous=${lastStatus?.status || 'none'}, changed=${statusChanged}`);
    
    // Send alerts only on status changes or new warnings
    if (statusChanged && status !== 'healthy') {
      const emoji = status === 'critical' ? '🚨' : '⚠️';
      let alertMessage = `${emoji} <b>SYSTEM ALERT - ${status.toUpperCase()}</b>\n\n`;
      alertMessage += `🖥️ <b>System Resources</b>\n`;
      alertMessage += `• CPU Usage: <b>${cpuUsage}%</b> ${cpuUsage >= CPU_WARNING_THRESHOLD ? '🔴' : '🟢'}\n`;
      alertMessage += `• RAM Usage: <b>${ramInfo.usagePercent}%</b> (${ramInfo.usedMemMB}MB / ${ramInfo.totalMemMB}MB) ${ramInfo.usagePercent >= RAM_WARNING_THRESHOLD ? '🔴' : '🟢'}\n`;
      alertMessage += `• Free RAM: ${ramInfo.freeMem}MB\n`;
      
      if (diskInfo) {
        alertMessage += `• Disk Usage: <b>${diskInfo.usagePercent}%</b> (${diskInfo.availGB}GB free / ${diskInfo.totalGB}GB total) ${diskInfo.usagePercent >= DISK_WARNING_THRESHOLD ? '🔴' : '🟢'}\n`;
      }
      
      alertMessage += `\n`;
      
      if (warnings.length > 0) {
        alertMessage += `📋 <b>Issues:</b>\n`;
        warnings.forEach(warning => {
          alertMessage += `  • ${warning}\n`;
        });
      }
      
      await sendToAllUsers(alertMessage);
      console.log(`⚠️ System alert sent: ${status.toUpperCase()}`);
    }
    
    // Recovery notification
    if (statusChanged && status === 'healthy' && lastStatus && lastStatus.status !== 'healthy') {
      console.log('🎉 Recovery conditions met, sending recovery message...');
      let msg = `✅ <b>SYSTEM RECOVERY</b>\n\n🖥️ System resources have returned to normal levels.\n`;
      msg += `• CPU Usage: ${cpuUsage}%\n`;
      msg += `• RAM Usage: ${ramInfo.usagePercent}% (${ramInfo.usedMemMB}MB / ${ramInfo.totalMemMB}MB)\n`;

      if (diskInfo) {
        msg += `• Disk Usage: ${diskInfo.usagePercent}% (${diskInfo.availGB}GB free)`;
      }

      await sendToAllUsers(msg);
      console.log('✅ System recovery notification sent');
    } else if (statusChanged && status === 'healthy') {
      console.log('ℹ️ Status changed to healthy but recovery conditions not met');
    }

    // Store in database AFTER alerts/recovery messages are sent
    insertSystemMetric.run(
      cpuUsage,
      ramInfo.usedMemMB,
      ramInfo.totalMemMB,
      ramInfo.usagePercent,
      diskInfo ? diskInfo.usedGB : null,
      diskInfo ? diskInfo.totalGB : null,
      diskInfo ? diskInfo.usagePercent : null,
      status,
      warningMessage
    );

    // Log verbose info
    if (process.env.LOG_VERBOSE === 'true') {
      const diskLog = diskInfo ? ` | Disk ${diskInfo.usagePercent}% (${diskInfo.availGB}GB free)` : '';
      console.log(`📊 System: CPU ${cpuUsage}% | RAM ${ramInfo.usagePercent}% (${ramInfo.usedMemMB}/${ramInfo.totalMemMB}MB)${diskLog} | Status: ${status}`);
    }
    
    return {
      status,
      cpuUsage,
      ramInfo,
      diskInfo,
      warnings: warnings.length > 0 ? warnings : null
    };
    
  } catch (error) {
    console.error('❌ Failed to check system health:', error);
    return { status: 'error', error: error.message };
  }
}

export function getSystemMetrics() {
  const cpuUsage = getCpuUsage();
  const ramInfo = getRamUsage();
  
  return {
    cpu: cpuUsage,
    ram: ramInfo,
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime()
  };
}

export function getThresholds() {
  return {
    ram: {
      warning: RAM_WARNING_THRESHOLD,
      critical: RAM_CRITICAL_THRESHOLD
    },
    cpu: {
      warning: CPU_WARNING_THRESHOLD,
      critical: CPU_CRITICAL_THRESHOLD
    },
    disk: {
      warning: DISK_WARNING_THRESHOLD,
      critical: DISK_CRITICAL_THRESHOLD
    }
  };
}

