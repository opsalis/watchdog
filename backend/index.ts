import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { startScheduler } from './scheduler';
import { processAlerts } from './alerting';
import {
  initBillingSchema,
  getSubscription,
  getTierLimits as billingTierLimits,
  applyUpgrade,
  cancelSubscription,
  verifyPaymentTx,
  renewalSweep,
  startRenewalCron,
  TIER_LIMITS,
  type Tier,
} from './billing';

const app = express();
app.use(express.json());

// CORS — allow the website
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// --- Config ---
const PORT    = parseInt(process.env.PORT    || '3300');
const DB_PATH = process.env.DB_PATH          || './data/pingdog.db';

// --- Database ---
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db: import('better-sqlite3').Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT,
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
    telegram_chat_id TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at TEXT,
    last_latency_ms REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1,
    public INTEGER NOT NULL DEFAULT 0,
    key_hash TEXT NOT NULL DEFAULT ''
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
    block_number INTEGER,
    is_stale INTEGER,
    agent_name TEXT,
    mcp_tools_count INTEGER,
    error TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    monitor_name TEXT,
    type TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    locations TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_checks_monitor ON checks(monitor_id, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_monitors_keyhash ON monitors(key_hash);
  CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, started_at DESC);
`);

// --- Auth middleware (key-hash based) ---
function authenticate(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] as string;
  if (!key || !key.startsWith('pdk_')) {
    res.status(401).json({ error: 'Missing or invalid X-API-Key header' });
    return;
  }
  // Compute key hash and attach to request
  (req as any).keyHash = createHash('sha256').update(key).digest('hex').substring(0, 16);
  next();
}

// --- Tier limits — backed by subscriptions table (see billing.ts) ---
initBillingSchema(db);

function getTierLimits(keyHash: string): { monitors: number; minInterval: number; regions: readonly string[] } {
  return billingTierLimits(db, keyHash);
}

// --- Prepared Statements ---
const insertMonitor = db.prepare(`
  INSERT INTO monitors (id, name, url, type, method, interval_seconds, timeout_ms, expect_status, expect_body, locations, webhook_url, telegram_chat_id, key_hash, public)
  VALUES (@id, @name, @url, @type, @method, @interval_seconds, @timeout_ms, @expect_status, @expect_body, @locations, @webhook_url, @telegram_chat_id, @key_hash, @public)
`);

const getMonitor         = db.prepare(`SELECT * FROM monitors WHERE id = ?`);
const getMonitorsByKey   = db.prepare(`SELECT * FROM monitors WHERE key_hash = ? AND active = 1 ORDER BY created_at DESC`);
const updateMonitorStatus = db.prepare(`UPDATE monitors SET status = ?, last_checked_at = datetime('now'), last_latency_ms = ? WHERE id = ?`);
const softDelete         = db.prepare(`UPDATE monitors SET active = 0 WHERE id = ? AND key_hash = ?`);
const updateMonitor      = db.prepare(`
  UPDATE monitors SET name=@name, url=@url, interval_seconds=@interval_seconds, timeout_ms=@timeout_ms,
    expect_status=@expect_status, expect_body=@expect_body, webhook_url=@webhook_url,
    telegram_chat_id=@telegram_chat_id, public=@public
  WHERE id=@id AND key_hash=@key_hash
`);
const getChecks          = db.prepare(`SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?`);
const getIncidents       = db.prepare(`SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`);
const insertIncident     = db.prepare(`
  INSERT INTO incidents (monitor_id, monitor_name, type, from_status, to_status, locations)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertCheck = db.prepare(`
  INSERT INTO checks (monitor_id, location, up, status_code, latency_ms, ssl_valid, ssl_days_left, block_number, is_stale, agent_name, mcp_tools_count, error)
  VALUES (@monitor_id, @location, @up, @status_code, @latency_ms, @ssl_valid, @ssl_days_left, @block_number, @is_stale, @agent_name, @mcp_tools_count, @error)
`);

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  const mc = db.prepare('SELECT COUNT(*) as c FROM monitors WHERE active = 1').get() as any;
  const cc = db.prepare('SELECT COUNT(*) as c FROM checks').get() as any;
  res.json({ status: 'ok', version: '2.1.0', monitors: mc.c, total_checks: cc.c, uptime: process.uptime() });
});

// ── Public API: /api/ routes (used by website) ──────────────────────────────

// POST /api/generate-key — generate a new pdk_ key (client-side is preferred,
// but backend endpoint allows testing and future server-side flows)
app.post('/api/generate-key', (_req: Request, res: Response) => {
  const hex = randomBytes(32).toString('hex');
  const key = `pdk_${hex}`;
  const keyHash = createHash('sha256').update(key).digest('hex').substring(0, 16);
  res.json({
    key,
    keyHash,
    message: 'Save your key — it will not be shown again.',
  });
});

// POST /api/monitors — create monitor
app.post('/api/monitors', authenticate, (req: Request, res: Response) => {
  const keyHash  = (req as any).keyHash as string;
  const limits   = getTierLimits(keyHash);

  // Count existing monitors for this key
  const count = (db.prepare('SELECT COUNT(*) as c FROM monitors WHERE key_hash = ? AND active = 1').get(keyHash) as any).c;
  if (count >= limits.monitors) {
    res.status(402).json({ error: `Monitor limit reached for your tier (${limits.monitors}). Upgrade to add more.` });
    return;
  }

  const {
    name, url, type = 'http', method = 'GET',
    interval_seconds = 300, timeout_ms = 10000,
    expect_status = 200, expect_body = null,
    regions = [], webhook_url = null, telegram_chat_id = null,
    public: isPublic = false
  } = req.body;

  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  // Enforce minimum interval
  const interval = Math.max(interval_seconds, limits.minInterval);

  const id = uuidv4();
  try {
    insertMonitor.run({
      id, name: name || url, url, type, method,
      interval_seconds: interval, timeout_ms,
      expect_status, expect_body,
      locations: JSON.stringify(regions.length ? regions : [...limits.regions]),
      webhook_url, telegram_chat_id,
      key_hash: keyHash,
      public: isPublic ? 1 : 0
    });
    const monitor = getMonitor.get(id);
    res.status(201).json(monitor);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/monitors/:keyHash — list monitors for key
app.get('/api/monitors/:keyHash', authenticate, (req: Request, res: Response) => {
  const keyHash = (req as any).keyHash as string;
  // Ensure the requester's key hash matches the requested keyHash
  if (keyHash !== req.params.keyHash) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const monitors = getMonitorsByKey.all(keyHash);
  res.json(monitors);
});

// PUT /api/monitors/:id — update monitor
app.put('/api/monitors/:id', authenticate, (req: Request, res: Response) => {
  const keyHash = (req as any).keyHash as string;
  const existing = getMonitor.get(req.params.id) as any;
  if (!existing || (existing as any).key_hash !== keyHash) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  const { name, url, interval_seconds, timeout_ms, expect_status, expect_body, webhook_url, telegram_chat_id, public: isPublic } = req.body;
  updateMonitor.run({
    id: req.params.id,
    key_hash: keyHash,
    name:             name             ?? existing.name,
    url:              url              ?? existing.url,
    interval_seconds: interval_seconds ?? existing.interval_seconds,
    timeout_ms:       timeout_ms       ?? existing.timeout_ms,
    expect_status:    expect_status    ?? existing.expect_status,
    expect_body:      expect_body      ?? existing.expect_body,
    webhook_url:      webhook_url      ?? existing.webhook_url,
    telegram_chat_id: telegram_chat_id ?? existing.telegram_chat_id,
    public:           isPublic != null ? (isPublic ? 1 : 0) : existing.public
  });
  res.json(getMonitor.get(req.params.id));
});

// DELETE /api/monitors/:id — delete monitor
app.delete('/api/monitors/:id', authenticate, (req: Request, res: Response) => {
  const keyHash = (req as any).keyHash as string;
  const result = softDelete.run(req.params.id, keyHash);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  res.json({ deleted: true });
});

// GET /api/results/:monitorId — check results history
app.get('/api/results/:monitorId', authenticate, (req: Request, res: Response) => {
  const keyHash = (req as any).keyHash as string;
  const monitor = getMonitor.get(req.params.monitorId) as any;
  if (!monitor || monitor.key_hash !== keyHash) {
    res.status(404).json({ error: 'Monitor not found' });
    return;
  }
  const limit = Math.min(parseInt(req.query.limit as string || '100'), 1000);
  const checks = getChecks.all(req.params.monitorId, limit);
  res.json(checks);
});

// GET /api/status/:keyHash — public status page (no auth required)
app.get('/api/status/:keyHash', (req: Request, res: Response) => {
  const keyHash = req.params.keyHash;
  const monitors = (db.prepare(`SELECT * FROM monitors WHERE key_hash = ? AND active = 1 AND public = 1`).all(keyHash)) as any[];

  const now = new Date().toISOString();

  const monitorData = monitors.map((m) => {
    // 24h uptime
    const allChecks = db.prepare(`
      SELECT up, checked_at, latency_ms, location FROM checks
      WHERE monitor_id = ? AND checked_at > datetime('now', '-24 hours')
      ORDER BY checked_at ASC
    `).all(m.id) as any[];

    const upCount = allChecks.filter((c: any) => c.up).length;
    const uptime24h = allChecks.length > 0 ? (upCount / allChecks.length) * 100 : null;

    // Latest latency
    const latest = allChecks[allChecks.length - 1];

    // Build 45-slot uptime bar (each slot = ~32 minutes)
    const slotMs = 24 * 60 * 60 * 1000 / 45;
    const segments: boolean[] = [];
    for (let i = 0; i < 45; i++) {
      const slotStart = new Date(Date.now() - (45 - i) * slotMs);
      const slotEnd   = new Date(Date.now() - (44 - i) * slotMs);
      const slotChecks = allChecks.filter((c: any) => {
        const t = new Date(c.checked_at).getTime();
        return t >= slotStart.getTime() && t < slotEnd.getTime();
      });
      if (slotChecks.length === 0) continue; // skip empty slots
      segments.push(slotChecks.some((c: any) => c.up));
    }

    return {
      id:          m.id,
      name:        m.name || m.url,
      type:        m.type,
      status:      m.status,
      uptime_24h:  uptime24h,
      latency_ms:  latest?.latency_ms || null,
      segments
    };
  });

  // Active incidents
  const incidentRows = monitors.length > 0
    ? db.prepare(`
        SELECT i.*, m.name as monitor_name FROM incidents i
        JOIN monitors m ON m.id = i.monitor_id
        WHERE m.key_hash = ? AND i.resolved_at IS NULL
        ORDER BY i.started_at DESC LIMIT 20
      `).all(keyHash) as any[]
    : [];

  res.json({
    checked_at: now,
    regions: 2,
    monitors: monitorData,
    incidents: incidentRows
  });
});

// ── Internal: checker reports results ───────────────────────────────────────

app.post('/v1/internal/check-result', (req: Request, res: Response) => {
  const {
    monitor_id, location, up, status_code, latency_ms,
    ssl_valid, ssl_days_left, error,
    block_number = null, is_stale = null, agent_name = null, mcp_tools_count = null
  } = req.body;

  if (!monitor_id || !location) {
    res.status(400).json({ error: 'monitor_id and location required' });
    return;
  }

  try {
    insertCheck.run({
      monitor_id, location,
      up:             up ? 1 : 0,
      status_code:    status_code    || null,
      latency_ms:     latency_ms     || null,
      ssl_valid:      ssl_valid  != null ? (ssl_valid ? 1 : 0) : null,
      ssl_days_left:  ssl_days_left  || null,
      block_number:   block_number   || null,
      is_stale:       is_stale  != null ? (is_stale ? 1 : 0) : null,
      agent_name:     agent_name     || null,
      mcp_tools_count: mcp_tools_count || null,
      error:          error          || null
    });

    // Consensus evaluation: get latest result per location in last 5 minutes
    const recentChecks = db.prepare(`
      SELECT location, up FROM checks
      WHERE monitor_id = ? AND checked_at > datetime('now', '-5 minutes')
      GROUP BY location
      ORDER BY checked_at DESC
    `).all(monitor_id) as any[];

    if (recentChecks.length > 0) {
      const downCount    = recentChecks.filter((c: any) => !c.up).length;
      const totalLocs    = recentChecks.length;
      const majority     = Math.ceil((totalLocs + 1) / 2); // majority = >50%
      const newStatus    = downCount >= majority ? 'down' : 'up';
      const monitor      = getMonitor.get(monitor_id) as any;

      if (monitor) {
        if (monitor.status !== newStatus && monitor.status !== 'unknown') {
          // State transition
          const downLocs = recentChecks.filter((c: any) => !c.up).map((c: any) => c.location);
          insertIncident.run(
            monitor_id,
            monitor.name || monitor.url,
            newStatus === 'down' ? 'outage' : 'recovery',
            monitor.status,
            newStatus,
            JSON.stringify(downLocs)
          );
          // Fire alerts
          try { processAlerts(monitor, newStatus, downLocs); } catch {}
        }
        updateMonitorStatus.run(newStatus, latency_ms || null, monitor_id);
      }
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Subscription / billing routes ───────────────────────────────────────────

// Simple per-IP rate limiter (in-memory, 20 req/min per IP)
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(req: Request, limit = 20, windowMs = 60_000): boolean {
  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || b.resetAt < now) { rateBuckets.set(ip, { count: 1, resetAt: now + windowMs }); return false; }
  b.count++;
  return b.count > limit;
}

// GET /api/subscription/:keyHash
app.get('/api/subscription/:keyHash', (req: Request, res: Response) => {
  if (rateLimited(req)) { res.status(429).json({ error: 'rate limit' }); return; }
  const keyHash = String(req.params.keyHash);
  const sub = getSubscription(db, keyHash);
  const limits = getTierLimits(keyHash);
  if (!sub) {
    res.json({ keyHash, tier: 'free', status: 'active', next_renewal_at: null, limits });
    return;
  }
  res.json({
    keyHash,
    tier: sub.tier,
    status: sub.status,
    started_at: sub.started_at,
    next_renewal_at: sub.next_renewal_at,
    customer_wallet: sub.customer_wallet,
    limits,
  });
});

// POST /api/upgrade  body { keyHash, tier, txHash }
app.post('/api/upgrade', async (req: Request, res: Response) => {
  if (rateLimited(req, 10, 60_000)) { res.status(429).json({ error: 'rate limit' }); return; }
  const { keyHash, tier, txHash } = req.body || {};
  if (!keyHash || typeof keyHash !== 'string' || keyHash.length < 8) {
    res.status(400).json({ error: 'keyHash required' }); return;
  }
  if (tier !== 'pro' && tier !== 'business') {
    res.status(400).json({ error: 'tier must be pro or business' }); return;
  }
  if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: 'txHash required (0x… 66 chars)' }); return;
  }

  try {
    const v = await verifyPaymentTx(txHash, tier as Tier, keyHash);
    if (!v.ok) { res.status(402).json({ error: `payment verification failed: ${v.error}` }); return; }
    const sub = applyUpgrade(db, {
      keyHash, tier: tier as Tier, txHash,
      customerWallet: v.customerWallet!, amount: v.amount!,
    });
    res.json({ ok: true, subscription: sub, limits: getTierLimits(keyHash) });
  } catch (e: any) {
    if (String(e.message).startsWith('payment_replay')) {
      res.status(409).json({ error: e.message }); return;
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cancel  body { keyHash }
app.post('/api/cancel', (req: Request, res: Response) => {
  if (rateLimited(req, 10, 60_000)) { res.status(429).json({ error: 'rate limit' }); return; }
  const { keyHash } = req.body || {};
  if (!keyHash || typeof keyHash !== 'string') { res.status(400).json({ error: 'keyHash required' }); return; }
  const sub = cancelSubscription(db, keyHash);
  if (!sub) { res.status(404).json({ error: 'no active subscription' }); return; }
  res.json({ ok: true, subscription: sub });
});

// POST /admin/billing/run-renewal — admin trigger for cron (for tests + ops)
app.post('/admin/billing/run-renewal', (req: Request, res: Response) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers['x-admin-key'] !== adminKey) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  try {
    const r = renewalSweep(db);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Internal: due monitors for checker
app.get('/v1/internal/due-monitors', (req: Request, res: Response) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PingDog API v2.1.0 listening on :${PORT}`);
  console.log(`Billing: tier limits free=${TIER_LIMITS.free.monitors} pro=${TIER_LIMITS.pro.monitors} business=${TIER_LIMITS.business.monitors}`);
  startScheduler(db);
  startRenewalCron(db);
});

export { db, app };
