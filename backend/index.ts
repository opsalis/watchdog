import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { startScheduler } from './scheduler';
import { processAlerts } from './alerting';

const app = express();
app.use(express.json());

// --- Config ---
const PORT = parseInt(process.env.PORT || '3300');
const DB_PATH = process.env.DB_PATH || './data/watchdog.db';
const API_KEY = process.env.API_KEY || '';

// --- Database ---
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'http',
    method TEXT NOT NULL DEFAULT 'GET',
    interval_seconds INTEGER NOT NULL DEFAULT 300,
    timeout_ms INTEGER NOT NULL DEFAULT 10000,
    expect_status INTEGER DEFAULT 200,
    expect_body TEXT,
    locations TEXT DEFAULT '[]',
    alert_channels TEXT DEFAULT '[]',
    webhook_url TEXT,
    alert_email TEXT,
    telegram_chat_id TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1,
    api_key TEXT,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    up INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms REAL,
    ssl_valid INTEGER,
    ssl_days_left INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    locations TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_checks_monitor ON checks(monitor_id, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, started_at DESC);
`);

// --- Auth Middleware ---
function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) { next(); return; }
  const key = req.headers['x-api-key'] as string;
  if (key !== API_KEY) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
}

// --- Prepared Statements ---
const insertMonitor = db.prepare(`
  INSERT INTO monitors (id, url, type, method, interval_seconds, timeout_ms, expect_status, expect_body, locations, alert_channels, webhook_url, alert_email, telegram_chat_id, api_key, name)
  VALUES (@id, @url, @type, @method, @interval_seconds, @timeout_ms, @expect_status, @expect_body, @locations, @alert_channels, @webhook_url, @alert_email, @telegram_chat_id, @api_key, @name)
`);

const listMonitors = db.prepare(`SELECT * FROM monitors WHERE active = 1 ORDER BY created_at DESC`);
const getMonitor = db.prepare(`SELECT * FROM monitors WHERE id = ?`);
const deleteMonitor = db.prepare(`UPDATE monitors SET active = 0 WHERE id = ?`);
const getChecks = db.prepare(`SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?`);
const getIncidents = db.prepare(`SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`);

const insertCheck = db.prepare(`
  INSERT INTO checks (monitor_id, location, up, status_code, latency_ms, ssl_valid, ssl_days_left, error)
  VALUES (@monitor_id, @location, @up, @status_code, @latency_ms, @ssl_valid, @ssl_days_left, @error)
`);

const updateMonitorStatus = db.prepare(`
  UPDATE monitors SET status = ?, last_checked_at = datetime('now') WHERE id = ?
`);

const insertIncident = db.prepare(`
  INSERT INTO incidents (monitor_id, type, from_status, to_status, locations)
  VALUES (?, ?, ?, ?, ?)
`);

// --- Routes ---

// Health
app.get('/health', (_req: Request, res: Response) => {
  const monitorCount = db.prepare('SELECT COUNT(*) as count FROM monitors WHERE active = 1').get() as any;
  const checkCount = db.prepare('SELECT COUNT(*) as count FROM checks').get() as any;
  res.json({
    status: 'ok',
    version: '1.0.0',
    monitors: monitorCount.count,
    total_checks: checkCount.count,
    uptime: process.uptime()
  });
});

// Create monitor
app.post('/v1/monitors', authenticate, (req: Request, res: Response) => {
  const id = uuidv4();
  const {
    url, type = 'http', method = 'GET', interval_seconds = 300,
    timeout_ms = 10000, expect_status = 200, expect_body = null,
    locations = [], alert_channels = [], webhook_url = null,
    alert_email = null, telegram_chat_id = null, name = null
  } = req.body;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  try {
    insertMonitor.run({
      id, url, type, method, interval_seconds, timeout_ms, expect_status,
      expect_body, locations: JSON.stringify(locations),
      alert_channels: JSON.stringify(alert_channels),
      webhook_url, alert_email, telegram_chat_id,
      api_key: req.headers['x-api-key'] || null, name
    });
    const monitor = getMonitor.get(id);
    res.status(201).json(monitor);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List monitors
app.get('/v1/monitors', authenticate, (_req: Request, res: Response) => {
  const monitors = listMonitors.all();
  res.json({ monitors });
});

// Get monitor
app.get('/v1/monitors/:id', authenticate, (req: Request, res: Response) => {
  const monitor = getMonitor.get(req.params.id) as any;
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  const recentChecks = getChecks.all(req.params.id, 20);
  const recentIncidents = getIncidents.all(req.params.id, 10);
  res.json({ ...monitor, recent_checks: recentChecks, recent_incidents: recentIncidents });
});

// Delete monitor
app.delete('/v1/monitors/:id', authenticate, (req: Request, res: Response) => {
  const result = deleteMonitor.run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json({ deleted: true });
});

// Get checks for a monitor
app.get('/v1/monitors/:id/checks', authenticate, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const checks = getChecks.all(req.params.id, limit);
  res.json({ checks });
});

// Get incidents for a monitor
app.get('/v1/monitors/:id/incidents', authenticate, (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const incidents = getIncidents.all(req.params.id, limit);
  res.json({ incidents });
});

// --- Internal: Checker reports results ---
app.post('/v1/internal/check-result', (req: Request, res: Response) => {
  const { monitor_id, location, up, status_code, latency_ms, ssl_valid, ssl_days_left, error } = req.body;

  if (!monitor_id || !location) {
    res.status(400).json({ error: 'monitor_id and location required' });
    return;
  }

  try {
    insertCheck.run({
      monitor_id, location, up: up ? 1 : 0,
      status_code: status_code || null,
      latency_ms: latency_ms || null,
      ssl_valid: ssl_valid != null ? (ssl_valid ? 1 : 0) : null,
      ssl_days_left: ssl_days_left || null,
      error: error || null
    });

    // Evaluate consensus and update status
    const recentChecks = db.prepare(`
      SELECT location, up FROM checks
      WHERE monitor_id = ? AND checked_at > datetime('now', '-5 minutes')
      GROUP BY location
      ORDER BY checked_at DESC
    `).all(monitor_id) as any[];

    if (recentChecks.length > 0) {
      const downCount = recentChecks.filter((c: any) => !c.up).length;
      const totalLocations = recentChecks.length;
      const newStatus = downCount > totalLocations / 2 ? 'down' : 'up';
      const monitor = getMonitor.get(monitor_id) as any;

      if (monitor && monitor.status !== newStatus && monitor.status !== 'unknown') {
        // State transition — create incident and fire alerts
        const downLocations = recentChecks.filter((c: any) => !c.up).map((c: any) => c.location);
        insertIncident.run(monitor_id, newStatus === 'down' ? 'outage' : 'recovery', monitor.status, newStatus, JSON.stringify(downLocations));
        processAlerts(monitor, newStatus, downLocations);
      }
      updateMonitorStatus.run(newStatus, monitor_id);
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Internal: Get due monitors for checker ---
app.get('/v1/internal/due-monitors', (req: Request, res: Response) => {
  const location = req.query.location as string || 'all';
  const monitors = db.prepare(`
    SELECT * FROM monitors
    WHERE active = 1
    AND (
      last_checked_at IS NULL
      OR datetime(last_checked_at, '+' || interval_seconds || ' seconds') <= datetime('now')
    )
  `).all();
  res.json({ monitors });
});

// --- Public status page API ---
app.get('/v1/status/:id', (req: Request, res: Response) => {
  const monitor = getMonitor.get(req.params.id) as any;
  if (!monitor) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const checks = getChecks.all(req.params.id, 100);
  const incidents = getIncidents.all(req.params.id, 10);
  // Return public-safe data only
  res.json({
    name: monitor.name || monitor.url,
    status: monitor.status,
    url: monitor.url,
    last_checked_at: monitor.last_checked_at,
    recent_checks: (checks as any[]).map((c: any) => ({
      location: c.location,
      up: !!c.up,
      latency_ms: c.latency_ms,
      checked_at: c.checked_at
    })),
    recent_incidents: incidents
  });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Watchdog API listening on :${PORT}`);
  startScheduler(db);
});

export { db, app };
