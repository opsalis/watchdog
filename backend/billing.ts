import Database from 'better-sqlite3';
import { ethers } from 'ethers';

/**
 * Billing — PingDog subscription + on-chain payment verification.
 *
 * Payments are routed through the shared OpsalisBilling contract on Demo L2
 * (chainId 845312). See ops/BILLING_CONTRACT_20260416.md for the authoritative
 * record.
 *
 * Flow:
 *  1. Customer approves USDC to OpsalisBilling, then calls pay(serviceId,
 *     productId, amount). A `Paid` event is emitted.
 *  2. Frontend posts {keyHash, tier, txHash} to /api/upgrade.
 *  3. Backend fetches the tx receipt, decodes the Paid log, verifies:
 *        - contract address = OpsalisBilling
 *        - serviceId = keccak256("pingdog")
 *        - productId matches the claimed tier
 *        - amount matches the tier price
 *     On success, records the subscription + payment_event.
 */

export const BILLING_CONTRACT  = process.env.BILLING_CONTRACT  || '0xCEfD64724E6EAbD3372188d3b558b1e74dD27Bc6';
export const USDC_CONTRACT     = process.env.USDC_CONTRACT     || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
export const L2_RPC_URL        = process.env.L2_RPC_URL        || 'http://l2-rpc.opsalis-l2-demo.svc.cluster.local:8545';
export const L2_CHAIN_ID       = parseInt(process.env.L2_CHAIN_ID || '845312');

export const SERVICE_ID_PINGDOG = ethers.id('pingdog'); // keccak256("pingdog")

// Product IDs = keccak256("<product-slug>")
export const PRODUCT_IDS = {
  pro:      ethers.id('pro-monthly'),
  business: ethers.id('business-monthly'),
} as const;

// USDC has 6 decimals on MockUSDC. Live pricing (JSON-LD on pingdog.net).
export const TIER_PRICES_USDC = {
  pro:       ethers.parseUnits('9.73',  6),   // $9.73
  business:  ethers.parseUnits('47.21', 6),   // $47.21
};

export const TIER_LIMITS = {
  free:     { monitors: 5,   minInterval: 300, regions: ['ca', 'de'] },
  pro:      { monitors: 50,  minInterval: 60,  regions: ['ca', 'de', 'sg', 'uk'] },
  business: { monitors: 500, minInterval: 30,  regions: ['ca', 'de', 'sg', 'uk'] },
} as const;

export type Tier = keyof typeof TIER_LIMITS;

export const PAID_EVENT_ABI = [
  'event Paid(bytes32 indexed serviceId, bytes32 indexed productId, address indexed customer, uint256 amount, uint256 timestamp)'
];

const paidIface = new ethers.Interface(PAID_EVENT_ABI);
const PAID_TOPIC = ethers.id('Paid(bytes32,bytes32,address,uint256,uint256)');

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export function initBillingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','pro','business')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      next_renewal_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','canceled','grace','expired')),
      last_payment_tx TEXT,
      customer_wallet TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subs_keyhash ON subscriptions(key_hash);
    CREATE INDEX IF NOT EXISTS idx_subs_renewal ON subscriptions(status, next_renewal_at);

    CREATE TABLE IF NOT EXISTS payment_events (
      tx_hash TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      amount TEXT NOT NULL,
      tier TEXT NOT NULL,
      customer_wallet TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payevents_keyhash ON payment_events(key_hash);
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription queries
// ─────────────────────────────────────────────────────────────────────────────

export function getSubscription(db: Database.Database, keyHash: string): any {
  return db.prepare(`SELECT * FROM subscriptions WHERE key_hash = ?`).get(keyHash);
}

/**
 * Returns the *effective* tier for tier-gating decisions.
 *  - active pro/business  → that tier
 *  - canceled but still before next_renewal_at → that tier (paid through)
 *  - grace  → that tier (7-day grace continues service)
 *  - expired / no row → free
 */
export function getEffectiveTier(db: Database.Database, keyHash: string): Tier {
  const sub: any = getSubscription(db, keyHash);
  if (!sub) return 'free';
  if (sub.status === 'expired') return 'free';
  if (sub.status === 'active' || sub.status === 'canceled' || sub.status === 'grace') {
    return (sub.tier as Tier) || 'free';
  }
  return 'free';
}

export function getTierLimits(db: Database.Database, keyHash: string) {
  return TIER_LIMITS[getEffectiveTier(db, keyHash)];
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain verification
// ─────────────────────────────────────────────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;
function provider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(L2_RPC_URL);
  return _provider;
}

export async function verifyPaymentTx(txHash: string, expectedTier: Tier, keyHashForLog: string): Promise<{
  ok: boolean;
  error?: string;
  customerWallet?: string;
  amount?: bigint;
}> {
  if (expectedTier === 'free') {
    return { ok: false, error: 'Free tier does not require payment' };
  }
  const expectedProduct = PRODUCT_IDS[expectedTier];
  const expectedAmount  = TIER_PRICES_USDC[expectedTier];

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider().getTransactionReceipt(txHash);
  } catch (e: any) {
    return { ok: false, error: `rpc error fetching receipt: ${e.message}` };
  }
  if (!receipt) return { ok: false, error: 'tx not found or not yet mined' };
  if (receipt.status !== 1) return { ok: false, error: 'tx reverted' };

  // Find Paid log from our billing contract
  const targetAddr = BILLING_CONTRACT.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== targetAddr) continue;
    if (!log.topics || log.topics[0] !== PAID_TOPIC) continue;

    let parsed: ethers.LogDescription | null;
    try {
      parsed = paidIface.parseLog({ topics: [...log.topics], data: log.data });
    } catch { continue; }
    if (!parsed) continue;

    const serviceId:  string = parsed.args.serviceId;
    const productId:  string = parsed.args.productId;
    const customer:   string = parsed.args.customer;
    const amount:     bigint = parsed.args.amount;

    if (serviceId !== SERVICE_ID_PINGDOG) {
      return { ok: false, error: `serviceId mismatch (got ${serviceId}, expected pingdog)` };
    }
    if (productId !== expectedProduct) {
      return { ok: false, error: `productId mismatch for tier=${expectedTier}` };
    }
    if (amount !== expectedAmount) {
      return { ok: false, error: `amount mismatch (got ${amount}, expected ${expectedAmount})` };
    }
    void keyHashForLog;
    return { ok: true, customerWallet: customer, amount };
  }
  return { ok: false, error: 'no matching Paid event in tx logs' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 86400_000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

export function applyUpgrade(db: Database.Database, params: {
  keyHash: string; tier: Tier; txHash: string; customerWallet: string; amount: bigint;
}): any {
  const { keyHash, tier, txHash, customerWallet, amount } = params;
  const now = new Date();
  const next = addDaysIso(now, 30);
  const txn = db.transaction(() => {
    // Idempotency — payment_events primary key is tx_hash
    const dup = db.prepare('SELECT tx_hash FROM payment_events WHERE tx_hash = ?').get(txHash);
    if (dup) throw new Error('payment_replay: this tx has already been used');

    db.prepare(`INSERT INTO payment_events (tx_hash, key_hash, amount, tier, customer_wallet)
                VALUES (?, ?, ?, ?, ?)`).run(txHash, keyHash, amount.toString(), tier, customerWallet);

    const existing: any = db.prepare(`SELECT id FROM subscriptions WHERE key_hash = ?`).get(keyHash);
    if (existing) {
      db.prepare(`UPDATE subscriptions
                  SET tier=?, status='active', next_renewal_at=?, last_payment_tx=?, customer_wallet=?, updated_at=datetime('now')
                  WHERE key_hash=?`).run(tier, next, txHash, customerWallet, keyHash);
    } else {
      db.prepare(`INSERT INTO subscriptions
                  (key_hash, tier, started_at, next_renewal_at, status, last_payment_tx, customer_wallet)
                  VALUES (?, ?, datetime('now'), ?, 'active', ?, ?)`)
        .run(keyHash, tier, next, txHash, customerWallet);
    }
  });
  txn();
  return getSubscription(db, keyHash);
}

export function cancelSubscription(db: Database.Database, keyHash: string): any {
  const sub: any = getSubscription(db, keyHash);
  if (!sub) return null;
  if (sub.status === 'expired') return sub;
  db.prepare(`UPDATE subscriptions SET status='canceled', updated_at=datetime('now') WHERE key_hash=?`).run(keyHash);
  return getSubscription(db, keyHash);
}

/**
 * Renewal sweep — should run daily.
 *  - canceled subs past next_renewal_at  → expired (downgrade to free)
 *  - active subs past next_renewal_at    → grace (7-day window to re-pay)
 *  - grace subs past grace_deadline      → expired
 */
export function renewalSweep(db: Database.Database): { expired: number; graced: number } {
  let expired = 0;
  let graced = 0;

  // Canceled → expired once grace period (= original next_renewal_at) passes
  const canceled: any[] = db.prepare(`
    SELECT key_hash, next_renewal_at FROM subscriptions
    WHERE status='canceled' AND next_renewal_at IS NOT NULL
      AND datetime(next_renewal_at) <= datetime('now')
  `).all();
  for (const row of canceled) {
    db.prepare(`UPDATE subscriptions SET status='expired', tier='free', updated_at=datetime('now') WHERE key_hash=?`).run(row.key_hash);
    expired++;
  }

  // Active past renewal → grace (7 days from renewal due)
  const dueActive: any[] = db.prepare(`
    SELECT key_hash, next_renewal_at FROM subscriptions
    WHERE status='active' AND next_renewal_at IS NOT NULL
      AND datetime(next_renewal_at) <= datetime('now')
  `).all();
  for (const row of dueActive) {
    // grace deadline = next_renewal_at + 7 days; we reuse next_renewal_at as the grace cut-off
    const newDeadline = addDaysIso(new Date(row.next_renewal_at.replace(' ', 'T') + 'Z'), 7);
    db.prepare(`UPDATE subscriptions SET status='grace', next_renewal_at=?, updated_at=datetime('now') WHERE key_hash=?`)
      .run(newDeadline, row.key_hash);
    graced++;
  }

  // Grace expired → expired (downgrade)
  const expiredGrace: any[] = db.prepare(`
    SELECT key_hash FROM subscriptions
    WHERE status='grace' AND next_renewal_at IS NOT NULL
      AND datetime(next_renewal_at) <= datetime('now')
  `).all();
  for (const row of expiredGrace) {
    db.prepare(`UPDATE subscriptions SET status='expired', tier='free', updated_at=datetime('now') WHERE key_hash=?`).run(row.key_hash);
    expired++;
  }

  return { expired, graced };
}

export function startRenewalCron(db: Database.Database, intervalMs: number = 24 * 60 * 60 * 1000): void {
  // Run once at boot, then daily.
  setTimeout(() => {
    try {
      const r = renewalSweep(db);
      if (r.expired || r.graced) console.log(`[billing] renewal sweep: expired=${r.expired} graced=${r.graced}`);
    } catch (e: any) {
      console.error('[billing] renewal sweep error:', e.message);
    }
  }, 30_000);
  setInterval(() => {
    try {
      const r = renewalSweep(db);
      if (r.expired || r.graced) console.log(`[billing] renewal sweep: expired=${r.expired} graced=${r.graced}`);
    } catch (e: any) {
      console.error('[billing] renewal sweep error:', e.message);
    }
  }, intervalMs);
}
