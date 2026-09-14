const express = require('express');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

router.get('/health', async (req, res) => {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = totalRam - freeRam;
  const ramUsagePercent = ((usedRam / totalRam) * 100).toFixed(2);

  const totalSwap = os.totalmem(); 
  const freeSwap = os.freemem();
  const usedSwap = totalSwap - freeSwap;
  const swapUsagePercent = ((usedSwap / totalSwap) * 100).toFixed(2);

  const cpus = os.cpus();
  const cpuInfo = {
    model: cpus[0].model,
    cores: cpus.length,
    speed: cpus[0].speed + ' MHz'
  };

  let diskUsage = 'Tidak tersedia';
  exec('df -h /', (error, stdout) => {
    if (!error) {
      const lines = stdout.trim().split('\n');
      const diskLine = lines[1];
      const parts = diskLine.split(/\s+/);
      diskUsage = {
        total: parts[1],
        used: parts[2],
        free: parts[3],
        usagePercent: parts[4]
      };
    }
    
    res.json({
      status: 'ok',
      service: 'turnstile-solver-js',
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      location: process.cwd(),
      ram: {
        total: formatBytes(totalRam),
        used: formatBytes(usedRam),
        free: formatBytes(freeRam),
        usagePercent: ramUsagePercent + '%'
      },
      swap: {
        total: formatBytes(totalSwap),
        used: formatBytes(usedSwap),
        free: formatBytes(freeSwap),
        usagePercent: swapUsagePercent + '%'
      },
      cpu: cpuInfo,
      disk: diskUsage
    });
  });
});

module.exports = router;