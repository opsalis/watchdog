import Database from 'better-sqlite3';

/**
 * Scheduler — evaluates which monitors are due for checking.
 * Runs inside the API server process.
 * Checkers poll /v1/internal/due-monitors to get their assignments.
 */

const EVAL_INTERVAL = parseInt(process.env.SCHEDULER_INTERVAL || '5000'); // 5s

export function startScheduler(db: Database.Database): void {
  console.log(`Scheduler started — evaluating every ${EVAL_INTERVAL}ms`);

  // The scheduler's job is lightweight: it just ensures the due-monitors
  // query works correctly by maintaining the last_checked_at timestamps.
  // The actual check timing is driven by the checker polling + interval_seconds.

  // Periodic cleanup of old checks (keep 30 days)
  setInterval(() => {
    try {
      const deleted = db.prepare(`
        DELETE FROM checks WHERE checked_at < datetime('now', '-30 days')
      `).run();
      if (deleted.changes > 0) {
        console.log(`Cleaned up ${deleted.changes} old checks`);
      }
    } catch (err: any) {
      console.error(`Cleanup error: ${err.message}`);
    }
  }, 60 * 60 * 1000); // Every hour

  // Periodic stale monitor detection
  setInterval(() => {
    try {
      const stale = db.prepare(`
        SELECT id, url, last_checked_at FROM monitors
        WHERE active = 1
        AND last_checked_at IS NOT NULL
        AND datetime(last_checked_at, '+' || (interval_seconds * 3) || ' seconds') < datetime('now')
      `).all() as any[];

      if (stale.length > 0) {
        console.warn(`${stale.length} monitors have not been checked in 3x their interval`);
      }
    } catch (err: any) {
      console.error(`Stale detection error: ${err.message}`);
    }
  }, EVAL_INTERVAL);
}
