'use strict';

const { WebSocket } = require('ws');
const https = require('https');
const http = require('http');
const tls = require('tls');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MASTER_URL       = process.env.MASTER_URL       || 'ws://localhost:4001/ws';
const WORKER_LOCATION  = process.env.WORKER_LOCATION  || 'unknown';
const RECONNECT_MS     = parseInt(process.env.RECONNECT_MS || '5000', 10);
const PING_INTERVAL_MS = 30000;

console.log(`[WORKER] location=${WORKER_LOCATION} master=${MASTER_URL}`);

// ---------------------------------------------------------------------------
// HTTP check
// ---------------------------------------------------------------------------
function checkUrl({ url, method = 'GET', expect_status = 200, timeout_ms = 10000 }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let parsed;
    try { parsed = new URL(url); } catch {
      return resolve({ up: false, error: 'invalid url', latency_ms: 0 });
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

    const options = {
      hostname: parsed.hostname,
      port,
      path:     parsed.pathname + parsed.search,
      method,
      timeout:  timeout_ms,
      headers:  { 'User-Agent': 'Watchdog-Monitor/1.0' },
      // Allow self-signed in checks but record ssl_valid separately
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      const latency_ms = Date.now() - start;
      // Drain body
      res.resume();

      // SSL info
      let ssl_valid = null;
      let ssl_days_left = null;
      if (isHttps && res.socket) {
        try {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const expiry = new Date(cert.valid_to).getTime();
            ssl_days_left = Math.floor((expiry - Date.now()) / 86400000);
            ssl_valid = ssl_days_left > 0 && res.socket.authorized !== false;
          }
        } catch { /* ignore ssl parse errors */ }
      }

      const up = res.statusCode === expect_status;
      resolve({ up, status: res.statusCode, latency_ms, ssl_valid, ssl_days_left });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false, error: 'timeout', latency_ms: timeout_ms });
    });

    req.on('error', (err) => {
      const latency_ms = Date.now() - start;
      resolve({ up: false, error: err.message, latency_ms });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// WebSocket connection with auto-reconnect
// ---------------------------------------------------------------------------
let ws = null;
let pingTimer = null;

function connect() {
  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }
  clearInterval(pingTimer);

  ws = new WebSocket(MASTER_URL, {
    headers: { 'x-worker-location': WORKER_LOCATION },
  });

  ws.on('open', () => {
    console.log('[WORKER] Connected to master');
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'check') {
      const { job_id, url, method, expect_status, timeout_ms } = msg;
      console.log(`[WORKER] Checking ${url} (job ${job_id})`);

      const result = await checkUrl({ url, method, expect_status, timeout_ms });

      const report = {
        type:          'result',
        job_id,
        location:      WORKER_LOCATION,
        up:            result.up,
        status:        result.status || null,
        latency_ms:    result.latency_ms,
        ssl_valid:     result.ssl_valid,
        ssl_days_left: result.ssl_days_left,
        error:         result.error || null,
        timestamp:     Date.now(),
      };

      console.log(`[WORKER] ${url} — ${result.up ? 'UP' : 'DOWN'} ${result.latency_ms}ms`);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(report));
      }

    } else if (msg.type === 'pong') {
      // heartbeat ack — no action needed
    } else if (msg.type === 'jobs') {
      console.log(`[WORKER] Received ${msg.jobs.length} active jobs from master`);
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    console.log(`[WORKER] Disconnected (code ${code}), reconnecting in ${RECONNECT_MS}ms`);
    setTimeout(connect, RECONNECT_MS);
  });

  ws.on('error', (err) => {
    console.error('[WORKER] WS error:', err.message);
    // close handler will trigger reconnect
  });
}

connect();
