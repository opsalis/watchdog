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
  // Extended fields for new check types
  block_number?: number | null;
  is_stale?: boolean | null;
  is_syncing?: boolean | null;
  agent_name?: string | null;
  agent_capabilities?: string[] | null;
  mcp_tools_count?: number | null;
}

// Track last seen block numbers for staleness detection
const lastBlockNumbers = new Map<string, { blockNum: number; seenAt: number }>();

// --- HTTP/HTTPS Check ---
async function checkHttp(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const url = new URL(monitor.url);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request(url, {
      method: monitor.method || 'GET',
      timeout: monitor.timeout_ms || 10000,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'PingDog/1.0' }
    }, (res) => {
      const latency = Date.now() - start;
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let up = true;
        let error: string | null = null;

        if (monitor.expect_status && res.statusCode !== monitor.expect_status) {
          up = false;
          error = `Expected status ${monitor.expect_status}, got ${res.statusCode}`;
        }

        if (monitor.expect_body && !body.includes(monitor.expect_body)) {
          up = false;
          error = `Expected body to contain "${monitor.expect_body}"`;
        }

        let sslValid: boolean | null = null;
        let sslDaysLeft: number | null = null;
        if (url.protocol === 'https:') {
          try {
            const socket = (res.socket as any);
            if (socket != null && typeof socket.getPeerCertificate === 'function') {
              const cert = socket.getPeerCertificate();
              if (cert && cert.valid_to) {
                const expiry = new Date(cert.valid_to);
                sslDaysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                sslValid = socket.authorized !== false && sslDaysLeft > 0;
              }
            }
          } catch { /* ignore SSL inspection errors */ }
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
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: monitor.timeout_ms, ssl_valid: null, ssl_days_left: null, error: 'Timeout' });
    });

    req.end();
  });
}

// --- TCP Check ---
async function checkTcp(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const rawUrl = monitor.url.startsWith('tcp://') ? monitor.url : `tcp://${monitor.url}`;
  const url = new URL(rawUrl);
  const port = parseInt(url.port) || 80;
  const host = url.hostname;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: monitor.timeout_ms || 10000 }, () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: true, status_code: null, latency_ms: latency, ssl_valid: null, ssl_days_left: null, error: null });
    });

    socket.on('error', (err) => {
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null, error: err.message });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: monitor.timeout_ms, ssl_valid: null, ssl_days_left: null, error: 'TCP timeout' });
    });
  });
}

// --- DNS Check ---
async function checkDns(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const hostname = monitor.url.replace(/^(https?|dns):\/\//, '').split('/')[0].split(':')[0];

  return new Promise((resolve) => {
    dns.resolve(hostname, (err, addresses) => {
      const latency = Date.now() - start;
      if (err) {
        resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: latency, ssl_valid: null, ssl_days_left: null, error: err.message });
      } else {
        resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: true, status_code: null, latency_ms: latency, ssl_valid: null, ssl_days_left: null, error: null });
      }
    });
  });
}

// --- SSL Certificate Check ---
async function checkSsl(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const rawUrl = monitor.url.startsWith('https://') ? monitor.url : `https://${monitor.url}`;
  const url = new URL(rawUrl);

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
        error: sslValid ? null : (sslDaysLeft <= 0 ? 'Certificate expired' : `Certificate expires in ${sslDaysLeft} days`)
      });
    });

    socket.on('error', (err) => {
      resolve({ monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: Date.now() - start, ssl_valid: false, ssl_days_left: null, error: err.message });
    });
  });
}

// --- RPC Health Check ---
async function checkRpc(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const timeout = monitor.timeout_ms || 10000;

  try {
    const url = new URL(monitor.url);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });

    const result = await new Promise<{ blockNum: number; latency: number }>((resolve, reject) => {
      const reqOpts = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'PingDog-RPC/1.0'
        },
        timeout,
        rejectUnauthorized: false
      };

      const req = client.request(reqOpts, (res) => {
        const latency = Date.now() - start;
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (json.error) { reject(new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`)); return; }
            if (!json.result) { reject(new Error('RPC returned no result')); return; }
            const blockNum = parseInt(json.result, 16);
            if (isNaN(blockNum)) { reject(new Error(`Invalid block number: ${json.result}`)); return; }
            resolve({ blockNum, latency });
          } catch (e: any) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body);
      req.end();
    });

    // Staleness detection: compare to last seen block
    const now = Date.now();
    const last = lastBlockNumbers.get(monitor.id);
    let isStale = false;

    if (last) {
      const ageMs = now - last.seenAt;
      const expectedBlocks = Math.floor(ageMs / 12000); // ~12s per block (ETH average)
      // If we expected at least 2 new blocks but got none, mark stale
      if (expectedBlocks >= 2 && result.blockNum <= last.blockNum) {
        isStale = true;
      }
    }

    lastBlockNumbers.set(monitor.id, { blockNum: result.blockNum, seenAt: now });

    return {
      monitor_id: monitor.id,
      location: NODE_LOCATION,
      up: !isStale,
      status_code: null,
      latency_ms: result.latency,
      ssl_valid: null,
      ssl_days_left: null,
      error: isStale ? `Block height stale: stuck at ${result.blockNum}` : null,
      block_number: result.blockNum,
      is_stale: isStale,
      is_syncing: false
    };

  } catch (err: any) {
    return {
      monitor_id: monitor.id,
      location: NODE_LOCATION,
      up: false,
      status_code: null,
      latency_ms: Date.now() - start,
      ssl_valid: null,
      ssl_days_left: null,
      error: err.message,
      block_number: null,
      is_stale: null,
      is_syncing: null
    };
  }
}

// --- A2A Agent Check ---
async function checkA2a(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const timeout = monitor.timeout_ms || 10000;
  const baseUrl = monitor.url.replace(/\/$/, '');

  try {
    // Step 1: Fetch agent card
    const cardUrl = `${baseUrl}/.well-known/agent-card.json`;
    const cardRes = await fetchJson(cardUrl, timeout);
    if (!cardRes.ok) {
      return { monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null, latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null, error: `Agent card fetch failed: ${cardRes.error}` };
    }

    // Step 2: Validate required fields
    const card = cardRes.data;
    const missing: string[] = [];
    if (!card.name) missing.push('name');
    if (!card.capabilities && !card.skills) missing.push('capabilities/skills');
    if (!card.url && !card.endpoint) missing.push('url/endpoint');

    if (missing.length > 0) {
      return {
        monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
        latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null,
        error: `Agent card missing fields: ${missing.join(', ')}`
      };
    }

    // Step 3: Ping the agent endpoint
    const agentEndpoint = card.url || card.endpoint || baseUrl;
    const pingBody = JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {}, id: 1 });
    const pingRes = await fetchWithTimeout(agentEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pingBody,
      timeout
    });

    const latency = Date.now() - start;

    return {
      monitor_id: monitor.id,
      location: NODE_LOCATION,
      up: pingRes.ok || pingRes.status < 500,
      status_code: pingRes.status,
      latency_ms: latency,
      ssl_valid: null,
      ssl_days_left: null,
      error: (!pingRes.ok && pingRes.status >= 500) ? `Agent ping returned ${pingRes.status}` : null,
      agent_name: card.name || null,
      agent_capabilities: Array.isArray(card.capabilities) ? card.capabilities : (card.skills ? Object.keys(card.skills) : null)
    };

  } catch (err: any) {
    return {
      monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
      latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null,
      error: err.message
    };
  }
}

// --- MCP Server Check ---
async function checkMcp(monitor: Monitor): Promise<CheckResult> {
  const start = Date.now();
  const timeout = monitor.timeout_ms || 10000;

  // Dynamically import ws to avoid breaking other checks if ws is not installed
  let WebSocket: any;
  try {
    const wsModule = await import('ws');
    WebSocket = wsModule.default || wsModule.WebSocket;
  } catch {
    return {
      monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
      latency_ms: 0, ssl_valid: null, ssl_days_left: null,
      error: 'ws package not installed — run: npm install ws'
    };
  }

  const wsUrl = monitor.url.replace(/^http/, 'ws');

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.terminate(); } catch {}
        resolve({
          monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
          latency_ms: timeout, ssl_valid: null, ssl_days_left: null,
          error: 'MCP connection timeout'
        });
      }
    }, timeout);

    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });

    ws.on('open', () => {
      // Send tools/list request (MCP protocol)
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      ws.send(req);
    });

    ws.on('message', (raw: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latency = Date.now() - start;
      try {
        const msg = JSON.parse(raw.toString());
        const tools = msg.result?.tools || msg.result || [];
        const toolCount = Array.isArray(tools) ? tools.length : 0;
        ws.terminate();
        resolve({
          monitor_id: monitor.id, location: NODE_LOCATION, up: true, status_code: null,
          latency_ms: latency, ssl_valid: null, ssl_days_left: null, error: null,
          mcp_tools_count: toolCount
        });
      } catch (e: any) {
        ws.terminate();
        resolve({
          monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
          latency_ms: latency, ssl_valid: null, ssl_days_left: null,
          error: `MCP response parse error: ${e.message}`
        });
      }
    });

    ws.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        monitor_id: monitor.id, location: NODE_LOCATION, up: false, status_code: null,
        latency_ms: Date.now() - start, ssl_valid: null, ssl_days_left: null,
        error: err.message
      });
    });
  });
}

// --- Helpers ---
function fetchJson(url: string, timeout: number): Promise<{ ok: boolean; data: any; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ ok: false, data: null, error: 'Invalid URL' }); return; }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'GET', timeout, rejectUnauthorized: false, headers: { 'User-Agent': 'PingDog/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(body) }); }
        catch { resolve({ ok: false, data: null, error: 'Invalid JSON response' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, data: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, error: 'Timeout' }); });
    req.end();
  });
}

function fetchWithTimeout(url: string, opts: { method: string; headers: Record<string, string>; body: string; timeout: number }): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ ok: false, status: 0 }); return; }

    const client = parsed.protocol === 'https:' ? https : http;
    const bodyBuf = Buffer.from(opts.body);
    const req = client.request(url, {
      method: opts.method,
      headers: { ...opts.headers, 'Content-Length': bodyBuf.length },
      timeout: opts.timeout,
      rejectUnauthorized: false
    }, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode || 0) < 400, status: res.statusCode || 0 });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.write(bodyBuf);
    req.end();
  });
}

// --- Route check to correct handler ---
async function performCheck(monitor: Monitor): Promise<CheckResult> {
  switch (monitor.type) {
    case 'tcp':  return checkTcp(monitor);
    case 'dns':  return checkDns(monitor);
    case 'ssl':  return checkSsl(monitor);
    case 'rpc':  return checkRpc(monitor);
    case 'a2a':  return checkA2a(monitor);
    case 'mcp':  return checkMcp(monitor);
    case 'http':
    case 'https':
    default:     return checkHttp(monitor);
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
        try { resolve(JSON.parse(body).monitors || []); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// --- Main loop ---
async function runCheckerLoop(): Promise<void> {
  console.log(`PingDog Checker starting — location: ${NODE_LOCATION}, API: ${API_URL}`);

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

if (require.main === module) {
  runCheckerLoop();
}

export { performCheck, checkHttp, checkTcp, checkDns, checkSsl, checkRpc, checkA2a, checkMcp };
