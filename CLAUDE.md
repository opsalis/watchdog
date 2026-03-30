# CLAUDE.md — Watchdog

> Read this first. All facts here are traceable to source code.

## What is Watchdog

Decentralized uptime monitoring service. Architecture: website → master server → slave workers.

- API owners register a URL to monitor; workers (in multiple locations) check it on a configurable interval.
- Master aggregates results, stores history in SQLite, fires alert webhooks on state transitions.
- Fully self-hosted. Also available as a managed hosted service.

## Relationship to Opsalis

This project runs on top of the Opsalis network as an independent business.
It registers its monitoring API via the Opsalis wrapper, earns USDC via the 95/5 settlement model.
No changes to Opsalis core required.

## Repository Structure

```
master/
  server.js       — Express :4001 + SQLite (better-sqlite3) + WebSocketServer
                    Routes: POST/GET/DELETE /v1/jobs, GET /v1/jobs/:id/checks,
                            GET /health, GET /v1/workers
                    Dispatch loop: every 5 s, respects per-job interval_s
                    Alert: fires webhook on UP/DOWN state transitions only
  Dockerfile      — node:22-alpine, installs express + better-sqlite3 + ws

worker/
  worker.js       — Connects to master WS, receives check jobs, performs HTTP(S),
                    reports result (up, latency_ms, ssl_valid, ssl_days_left)
                    Auto-reconnect with configurable RECONNECT_MS
  Dockerfile      — node:22-alpine, installs ws only

website/
  index.html      — Landing page: hero, how it works, install, pricing, API preview

docker-compose.yml — master + worker-1 + worker-2, watchdog_data volume
README.md          — setup, architecture, API reference, config tables
```

## Tech Stack

- Node.js 22, no TypeScript (skeleton phase)
- Express 4 (master HTTP)
- better-sqlite3 (master storage, WAL mode)
- ws (WebSocket — both master server and worker client)
- No external dependencies on the worker (uses built-in `http`/`https`/`tls`)

## Key Design Decisions

- **Master is the single source of truth.** Workers are stateless; they receive jobs on connect and execute checks.
- **No job caching on workers.** Workers only act when they receive a `check` message.
- **Dispatch loop is on master.** Every 5 s the master evaluates which jobs are due and sends `check` messages.
- **Alerts are edge-triggered.** A webhook fires only when a site transitions UP→DOWN or DOWN→UP, never on every poll.
- **SSL check uses `rejectUnauthorized: false`.** This allows checking sites with expired certs while still reporting validity via `ssl_valid` / `ssl_days_left`.
- **Workers auto-reconnect.** If the master restarts, workers reconnect and immediately receive updated job list.
- **SQLite WAL mode + foreign keys.** Safe concurrent reads; checks are cascade-deleted with their job.

## Environment Variables

### Master
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4001` | Listen port |
| `DB_PATH` | `./watchdog.db` | SQLite path |
| `ALERT_WEBHOOK` | — | HTTP POST URL for alerts |

### Worker
| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_URL` | `ws://localhost:4001/ws` | Master WebSocket URL |
| `WORKER_LOCATION` | `unknown` | Location label in results |
| `RECONNECT_MS` | `5000` | Reconnect delay (ms) |

## Database Schema

```sql
jobs (
  id TEXT PK, url, method, interval_s, locations JSON,
  alert_email, expect_status, timeout_ms, created_at, active
)

checks (
  id INTEGER PK AUTOINCREMENT,
  job_id → jobs.id ON DELETE CASCADE,
  location, worker_id, up, status, latency_ms,
  ssl_valid, ssl_days_left, error, checked_at
)
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/jobs | Create monitoring job |
| GET | /v1/jobs | List active jobs |
| GET | /v1/jobs/:id | Job + 24h stats + 10 recent checks |
| DELETE | /v1/jobs/:id | Deactivate job |
| GET | /v1/jobs/:id/checks | Check history (max 1000) |
| GET | /health | Server health + worker count |
| GET | /v1/workers | Connected workers list |
| WS | /ws | Worker connections |

## WebSocket Protocol

### Master → Worker
```json
{ "type": "check", "job_id", "url", "method", "expect_status", "timeout_ms" }
{ "type": "jobs", "jobs": [...] }   // sent on connect
{ "type": "pong" }
```

### Worker → Master
```json
{ "type": "result", "job_id", "location", "up", "status", "latency_ms",
  "ssl_valid", "ssl_days_left", "error", "timestamp" }
{ "type": "ping" }
```

## Build & Run

```bash
# Local dev
docker compose up -d

# Scale workers
docker compose up -d --scale worker-1=3

# Remote worker
docker run -d \
  -e MASTER_URL=ws://MASTER_IP:4001/ws \
  -e WORKER_LOCATION=eu-frankfurt \
  --restart unless-stopped \
  watchdog-worker

# API smoke test
curl -X POST http://localhost:4001/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","interval_seconds":30}'
curl http://localhost:4001/v1/jobs
curl http://localhost:4001/health
```

## Status

SKELETON — core architecture implemented, functional but not production-hardened.

## What's NOT Done (next phases)

- Authentication on master API (API key or JWT)
- TLS on master (nginx reverse proxy or built-in)
- Status page (public HTML per job)
- Dashboard web UI
- Hosted billing integration (USDC via Opsalis)
- Multi-sig result verification (quorum: N of M workers must agree before alert)
- Prometheus metrics endpoint
- Persistent alert deduplication (survives master restart)
- Rate limiting on job creation

## Repository

https://github.com/opsalis/watchdog
