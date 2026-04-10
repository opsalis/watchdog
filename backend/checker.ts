import http from 'http';
import https from 'https';
import { URL } from 'url';
import net from 'net';
import dns from 'dns';
import tls from 'tls';

const API_URL = process.env.API_URL || 'http://watchdog-api:3300';
const NODE_LOCATION = process.env.NODE_LOCATION || process.env.HOSTNAME || 'unknown';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000'); // 15s

interface Monitor {
  id: string;
  url: string;
  type: string;
  method: string;
  timeout_ms: number;
  expect_status: number;
  expect_body: string | null;
}

interface CheckResult {
  monitor_id: string;
  location: string;
  up: boolean;
  status_code: number | null;
  latency_ms: number | null;
  ssl_valid: boolean | null;
  ssl_days_left: number | null;
  error: string | null;
}

// --- HTTP/HTTPS Check ---
async function checkHttp(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const url = new URL(monitor.url);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request(url, {
      method: monitor.method || 'GET',
      timeout: monitor.timeout_ms || 10000,
      rejectUnauthorized: false, // Still check SSL but don't reject
      headers: { 'User-Agent': 'Watchdog/1.0' }
    }, (res) => {
      const latency = Date.now() - start;
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let up = true;
        let error = null;

        // Check status code
        if (monitor.expect_status && res.statusCode !== monitor.expect_status) {
          up = false;
          error = `Expected status ${monitor.expect_status}, got ${res.statusCode}`;
        }

        // Check body content
        if (monitor.expect_body && !body.includes(monitor.expect_body)) {
          up = false;
          error = `Expected body to contain "${monitor.expect_body}"`;
        }

        // SSL info
        let sslValid: boolean | null = null;
        let sslDaysLeft: number | null = null;
        if (url.protocol === 'https:') {
          const socket = (res.socket as any);
          if (socket.getPeerCertificate) {
            const cert = socket.getPeerCertificate();
            if (cert && cert.valid_to) {
              const expiry = new Date(cert.valid_to);
              sslDaysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              sslValid = socket.authorized !== false && sslDaysLeft > 0;
            }
          }
        }

        resolve({
          monitor_id: monitor.id,
          location: NODE_LOCATION,
          up,
          status_code: res.statusCode || null,
          latency_ms: latency,
          ssl_valid: sslValid,
          ssl_days_left: sslDaysLeft,
          error
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: false,
        status_code: null,
        latency_ms: Date.now() - start,
        ssl_valid: null,
        ssl_days_left: null,
        error: err.message
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: false,
        status_code: null,
        latency_ms: monitor.timeout_ms,
        ssl_valid: null,
        ssl_days_left: null,
        error: 'Timeout'
      });
    });

    req.end();
  });
}

// --- TCP Check ---
async function checkTcp(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const url = new URL(monitor.url.startsWith('tcp://') ? monitor.url : `tcp://${monitor.url}`);
  const port = parseInt(url.port) || 80;
  const host = url.hostname;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: monitor.timeout_ms || 10000 }, () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: true,
        status_code: null,
        latency_ms: latency,
        ssl_valid: null,
        ssl_days_left: null,
        error: null
      });
    });

    socket.on('error', (err) => {
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: false,
        status_code: null,
        latency_ms: Date.now() - start,
        ssl_valid: null,
        ssl_days_left: null,
        error: err.message
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: false,
        status_code: null,
        latency_ms: monitor.timeout_ms,
        ssl_valid: null,
        ssl_days_left: null,
        error: 'TCP timeout'
      });
    });
  });
}

// --- DNS Check ---
async function checkDns(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const hostname = monitor.url.replace(/^(https?|dns):\/\//, '').split('/')[0];

  return new Promise((resolve) => {
    dns.resolve(hostname, (err, addresses) => {
      const latency = Date.now() - start;
      if (err) {
        resolve({
          monitor_id: monitor.id,
          location: NODE_LOCATION,
          up: false,
          status_code: null,
          latency_ms: latency,
          ssl_valid: null,
          ssl_days_left: null,
          error: err.message
        });
      } else {
        resolve({
          monitor_id: monitor.id,
          location: NODE_LOCATION,
          up: true,
          status_code: null,
          latency_ms: latency,
          ssl_valid: null,
          ssl_days_left: null,
          error: null
        });
      }
    });
  });
}

// --- SSL Certificate Check ---
async function checkSsl(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const url = new URL(monitor.url.startsWith('https://') ? monitor.url : `https://${monitor.url}`);

  return new Promise((resolve) => {
    const socket = tls.connect({
      host: url.hostname,
      port: parseInt(url.port) || 443,
      rejectUnauthorized: false,
      timeout: monitor.timeout_ms || 10000
    }, () => {
      const latency = Date.now() - start;
      const cert = socket.getPeerCertificate();
      let sslValid = false;
      let sslDaysLeft = 0;

      if (cert && cert.valid_to) {
        const expiry = new Date(cert.valid_to);
        sslDaysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        sslValid = socket.authorized && sslDaysLeft > 0;
      }

      socket.destroy();
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: sslValid,
        status_code: null,
        latency_ms: latency,
        ssl_valid: sslValid,
        ssl_days_left: sslDaysLeft,
        error: sslValid ? null : `SSL expires in ${sslDaysLeft} days`
      });
    });

    socket.on('error', (err) => {
      resolve({
        monitor_id: monitor.id,
        location: NODE_LOCATION,
        up: false,
        status_code: null,
        latency_ms: Date.now() - start,
        ssl_valid: false,
        ssl_days_left: null,
        error: err.message
      });
    });
  });
}

// --- Route check to correct handler ---
async function performCheck(monitor: Monitor): Promise<CheckResult> {
  switch (monitor.type) {
    case 'tcp': return checkTcp(monitor);
    case 'dns': return checkDns(monitor);
    case 'ssl': return checkSsl(monitor);
    case 'http':
    case 'https':
    default: return checkHttp(monitor);
  }
}

// --- Report result to API server ---
async function reportResult(result: CheckResult): Promise<void> {
  const data = JSON.stringify(result);
  const url = new URL(`${API_URL}/v1/internal/check-result`);

  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, () => resolve());
    req.on('error', (err) => {
      console.error(`Failed to report result: ${err.message}`);
      resolve();
    });
    req.write(data);
    req.end();
  });
}

// --- Fetch due monitors from API ---
async function fetchDueMonitors(): Promise<Monitor[]> {
  const url = new URL(`${API_URL}/v1/internal/due-monitors?location=${NODE_LOCATION}`);

  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.monitors || []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// --- Main loop ---
async function runCheckerLoop(): Promise<void> {
  console.log(`Watchdog Checker starting — location: ${NODE_LOCATION}, API: ${API_URL}`);

  while (true) {
    try {
      const monitors = await fetchDueMonitors();
      if (monitors.length > 0) {
        console.log(`Checking ${monitors.length} monitors from ${NODE_LOCATION}`);
        const results = await Promise.all(monitors.map(performCheck));
        await Promise.all(results.map(reportResult));
      }
    } catch (err: any) {
      console.error(`Checker error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// Run as standalone
if (require.main === module) {
  runCheckerLoop();
}

export { performCheck, checkHttp, checkTcp, checkDns, checkSsl };
