'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4001', 10);
const DB_PATH = process.env.DB_PATH || './watchdog.db';
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || null; // optional HTTP webhook URL

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT 'GET',
    interval_s  INTEGER NOT NULL DEFAULT 60,
    locations   TEXT NOT NULL DEFAULT '["any"]',
    alert_email TEXT,
    expect_status INTEGER NOT NULL DEFAULT 200,
    timeout_ms  INTEGER NOT NULL DEFAULT 10000,
    created_at  INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    location    TEXT NOT NULL,
    worker_id   TEXT NOT NULL,
    up          INTEGER NOT NULL,
    status      INTEGER,
    latency_ms  INTEGER,
    ssl_valid   INTEGER,
    ssl_days_left INTEGER,
    error       TEXT,
    checked_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checks_job_id ON checks(job_id);
  CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
`);

const stmts = {
  insertJob: db.prepare(`
    INSERT INTO jobs (id, url, method, interval_s, locations, alert_email, expect_status, timeout_ms, created_at)
    VALUES (@id, @url, @method, @interval_s, @locations, @alert_email, @expect_status, @timeout_ms, @created_at)
  `),
  listJobs: db.prepare('SELECT * FROM jobs WHERE active = 1 ORDER BY created_at DESC'),
  getJob:   db.prepare('SELECT * FROM jobs WHERE id = ?'),
  deleteJob: db.prepare('UPDATE jobs SET active = 0 WHERE id = ?'),
  insertCheck: db.prepare(`
    INSERT INTO checks (job_id, location, worker_id, up, status, latency_ms, ssl_valid, ssl_days_left, error, checked_at)
    VALUES (@job_id, @location, @worker_id, @up, @status, @latency_ms, @ssl_valid, @ssl_days_left, @error, @checked_at)
  `),
  getChecks: db.prepare(`
    SELECT * FROM checks WHERE job_id = ? ORDER BY checked_at DESC LIMIT ?
  `),
  uptimeStats: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(up)  AS up_count,
      AVG(latency_ms) AS avg_latency,
      MIN(latency_ms) AS min_latency,
      MAX(latency_ms) AS max_latency
    FROM checks WHERE job_id = ? AND checked_at > ?
  `),
};

// ---------------------------------------------------------------------------
// Worker registry  (connected WebSocket clients)
// ---------------------------------------------------------------------------
const workers = new Map(); // worker_id -> { ws, location, last_seen }

// ---------------------------------------------------------------------------
// Dispatch loop
// ---------------------------------------------------------------------------
// Track when each job was last dispatched per location
const lastDispatch = new Map(); // job_id -> last_dispatch_ts_ms

function dispatchDue() {
  const now = Date.now();
  const jobs = stmts.listJobs.all();
  if (workers.size === 0) return;

  for (const job of jobs) {
    const key = job.id;
    const last = lastDispatch.get(key) || 0;
    if (now - last < job.interval_s * 1000) continue;

    lastDispatch.set(key, now);

    // Pick one worker per requested location (or any available worker)
    const locations = JSON.parse(job.locations);
    const chosen = pickWorkers(locations);
    if (chosen.length === 0) continue;

    const msg = JSON.stringify({
      type:           'check',
      job_id:         job.id,
      url:            job.url,
      method:         job.method,
      expect_status:  job.expect_status,
      timeout_ms:     job.timeout_ms,
    });

    for (const w of chosen) {
      if (w.ws.readyState === WebSocket.OPEN) {
        w.ws.send(msg);
      }
    }
  }
}

function pickWorkers(locations) {
  const available = [...workers.values()].filter(w => w.ws.readyState === WebSocket.OPEN);
  if (available.length === 0) return [];

  if (locations.includes('any')) {
    // One random worker
    return [available[Math.floor(Math.random() * available.length)]];
  }

  const picked = [];
  for (const loc of locations) {
    const match = available.filter(w => w.location === loc);
    if (match.length > 0) {
      picked.push(match[Math.floor(Math.random() * match.length)]);
    }
  }
  // Fall back to any if no location match
  return picked.length > 0 ? picked : [available[0]];
}

setInterval(dispatchDue, 5000); // check every 5 s; individual job intervals enforced above

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------
const lastAlertState = new Map(); // job_id -> { up: bool, alerted_at }

function maybeAlert(job, result) {
  const prev = lastAlertState.get(job.id);
  const wasUp = prev ? prev.up : true; // assume up initially

  if (wasUp && !result.up) {
    // Transition: up -> down
    lastAlertState.set(job.id, { up: false, alerted_at: Date.now() });
    sendAlert(job, result, 'DOWN');
  } else if (!wasUp && result.up) {
    // Transition: down -> up
    lastAlertState.set(job.id, { up: true, alerted_at: Date.now() });
    sendAlert(job, result, 'UP');
  } else {
    lastAlertState.set(job.id, { up: result.up, alerted_at: (prev || {}).alerted_at });
  }
}

async function sendAlert(job, result, state) {
  const body = {
    job_id:   job.id,
    url:      job.url,
    state,
    latency_ms: result.latency_ms,
    location:   result.location,
    timestamp:  result.timestamp,
    alert_email: job.alert_email,
  };

  console.log(`[ALERT] ${state} — ${job.url} (job ${job.id})`);

  if (ALERT_WEBHOOK) {
    try {
      const res = await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error(`[ALERT] Webhook returned ${res.status}`);
    } catch (err) {
      console.error('[ALERT] Webhook error:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Health
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    workers: workers.size,
    jobs: stmts.listJobs.all().length,
    uptime_s: Math.floor(process.uptime()),
  });
});

// POST /v1/jobs
app.post('/v1/jobs', (req, res) => {
  const { url, interval_seconds, locations, alert_email, method, expect_status, timeout_ms } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return res.status(400).json({ error: 'url is invalid' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'url must be http or https' });
  }

  const job = {
    id:            crypto.randomUUID(),
    url,
    method:        (method || 'GET').toUpperCase(),
    interval_s:    Math.max(10, parseInt(interval_seconds || 60, 10)),
    locations:     JSON.stringify(Array.isArray(locations) ? locations : ['any']),
    alert_email:   alert_email || null,
    expect_status: parseInt(expect_status || 200, 10),
    timeout_ms:    parseInt(timeout_ms || 10000, 10),
    created_at:    Date.now(),
  };

  stmts.insertJob.run(job);
  console.log(`[JOB] Created ${job.id} — ${job.url}`);
  return res.status(201).json({ ...job, locations: JSON.parse(job.locations) });
});

// GET /v1/jobs
app.get('/v1/jobs', (_req, res) => {
  const jobs = stmts.listJobs.all().map(decorateJob);
  return res.json(jobs);
});

// GET /v1/jobs/:id
app.get('/v1/jobs/:id', (req, res) => {
  const job = stmts.getJob.get(req.params.id);
  if (!job || !job.active) return res.status(404).json({ error: 'not found' });

  const since = Date.now() - 24 * 60 * 60 * 1000; // last 24 h
  const stats = stmts.uptimeStats.get(job.id, since);
  const recent = stmts.getChecks.all(job.id, 10);

  return res.json({
    ...decorateJob(job),
    stats: {
      uptime_pct:  stats.total ? ((stats.up_count / stats.total) * 100).toFixed(2) : null,
      avg_latency: stats.avg_latency ? Math.round(stats.avg_latency) : null,
      min_latency: stats.min_latency,
      max_latency: stats.max_latency,
      total_checks_24h: stats.total,
    },
    recent_checks: recent,
  });
});

// DELETE /v1/jobs/:id
app.delete('/v1/jobs/:id', (req, res) => {
  const job = stmts.getJob.get(req.params.id);
  if (!job || !job.active) return res.status(404).json({ error: 'not found' });
  stmts.deleteJob.run(req.params.id);
  lastDispatch.delete(req.params.id);
  console.log(`[JOB] Deleted ${req.params.id}`);
  return res.json({ ok: true });
});

// GET /v1/jobs/:id/checks
app.get('/v1/jobs/:id/checks', (req, res) => {
  const job = stmts.getJob.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(parseInt(req.query.limit || 100, 10), 1000);
  const checks = stmts.getChecks.all(req.params.id, limit);
  return res.json(checks);
});

// GET /v1/workers (debug)
app.get('/v1/workers', (_req, res) => {
  const list = [...workers.entries()].map(([id, w]) => ({
    id,
    location: w.location,
    last_seen: w.last_seen,
    connected_s: Math.floor((Date.now() - w.connected_at) / 1000),
  }));
  return res.json(list);
});

function decorateJob(j) {
  return { ...j, locations: JSON.parse(j.locations) };
}

// ---------------------------------------------------------------------------
// HTTP server + WebSocket
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const worker_id = crypto.randomUUID();
  const ip = req.socket.remoteAddress;
  const location = req.headers['x-worker-location'] || 'unknown';

  workers.set(worker_id, { ws, location, last_seen: Date.now(), connected_at: Date.now() });
  console.log(`[WS] Worker connected: ${worker_id} location=${location} ip=${ip}`);

  // Send current job list on connect so worker is ready immediately
  const jobs = stmts.listJobs.all();
  ws.send(JSON.stringify({ type: 'jobs', jobs }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'result') {
      const w = workers.get(worker_id);
      if (w) w.last_seen = Date.now();

      const job = stmts.getJob.get(msg.job_id);
      if (!job) return;

      stmts.insertCheck.run({
        job_id:        msg.job_id,
        location:      msg.location || location,
        worker_id,
        up:            msg.up ? 1 : 0,
        status:        msg.status || null,
        latency_ms:    msg.latency_ms || null,
        ssl_valid:     msg.ssl_valid != null ? (msg.ssl_valid ? 1 : 0) : null,
        ssl_days_left: msg.ssl_days_left || null,
        error:         msg.error || null,
        checked_at:    msg.timestamp || Date.now(),
      });

      maybeAlert(job, { ...msg, location: msg.location || location });

    } else if (msg.type === 'ping') {
      const w = workers.get(worker_id);
      if (w) w.last_seen = Date.now();
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    workers.delete(worker_id);
    console.log(`[WS] Worker disconnected: ${worker_id}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Worker error ${worker_id}:`, err.message);
    workers.delete(worker_id);
  });
});

server.listen(PORT, () => {
  console.log(`[MASTER] Watchdog master listening on :${PORT}`);
});
