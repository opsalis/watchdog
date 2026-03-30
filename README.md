# Watchdog

Decentralized uptime monitoring. One master server, workers anywhere.

```
website → master (port 4001) ← workers (WebSocket)
                ↓
           SQLite DB
                ↓
         alert webhook
```

## Quick start

```bash
git clone https://github.com/opsalis/watchdog.git
cd watchdog
docker compose up -d
```

Master is available at `http://localhost:4001`.

## Architecture

| Component | Description |
|-----------|-------------|
| `master/server.js` | Express + SQLite + WebSocketServer. Stores jobs, dispatches checks, aggregates results, sends alerts. |
| `worker/worker.js` | Connects to master via WebSocket. Performs HTTP/HTTPS checks. Reports latency, status, SSL info. |

### Data flow

1. Client calls `POST /v1/jobs` on the master.
2. Master stores the job in SQLite.
3. Every 5 seconds the dispatch loop runs — any job whose `interval_s` has elapsed gets a `check` message sent to an available worker.
4. Worker performs the HTTP request and sends back a `result` message.
5. Master stores the result. If the site changed state (up→down or down→up) an alert webhook is fired.

### Worker connection

Workers connect via WebSocket to `ws://master:4001/ws` with header `x-worker-location: <location>`.

On connect, the master sends the current job list. Workers send a `ping` every 30 seconds; master replies with `pong`.

Workers auto-reconnect after disconnect.

## API reference

### POST /v1/jobs

Create a monitoring job.

```json
{
  "url": "https://example.com",
  "interval_seconds": 60,
  "locations": ["any"],
  "alert_email": "ops@example.com",
  "method": "GET",
  "expect_status": 200,
  "timeout_ms": 10000
}
```

`locations` is a list of worker location names. Use `["any"]` to use any available worker.

Returns the created job object.

### GET /v1/jobs

List all active jobs.

### GET /v1/jobs/:id

Get job with 24-hour uptime stats and 10 most recent checks.

```json
{
  "id": "...",
  "url": "https://example.com",
  "stats": {
    "uptime_pct": "99.72",
    "avg_latency": 87,
    "min_latency": 31,
    "max_latency": 412,
    "total_checks_24h": 1440
  },
  "recent_checks": [...]
}
```

### DELETE /v1/jobs/:id

Stop monitoring a job.

### GET /v1/jobs/:id/checks?limit=100

Get check history. Max 1000 records.

### GET /health

Server health including connected worker count.

### GET /v1/workers

List connected workers with location and last-seen time.

## Configuration

### Master environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4001` | HTTP/WS listen port |
| `DB_PATH` | `./watchdog.db` | SQLite database path |
| `ALERT_WEBHOOK` | — | HTTP POST URL for up/down alerts |

### Worker environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_URL` | `ws://localhost:4001/ws` | Master WebSocket URL |
| `WORKER_LOCATION` | `unknown` | Location label shown in results |
| `RECONNECT_MS` | `5000` | Reconnect delay after disconnect |

## Adding a remote worker

Deploy the worker container on any server:

```bash
docker run -d \
  -e MASTER_URL=ws://YOUR_MASTER_IP:4001/ws \
  -e WORKER_LOCATION=eu-frankfurt \
  --restart unless-stopped \
  watchdog-worker
```

The master must be reachable from the worker. If the master is behind a firewall, open port 4001.

## Alert payload

When a monitored URL changes state, the master POSTs this JSON to `ALERT_WEBHOOK`:

```json
{
  "job_id": "abc-123",
  "url": "https://example.com",
  "state": "DOWN",
  "latency_ms": 10000,
  "location": "eu-frankfurt",
  "timestamp": 1711800000000,
  "alert_email": "ops@example.com"
}
```

`state` is either `"UP"` or `"DOWN"`. The alert fires only on state transitions.

## Building

```bash
# Build images
docker compose build

# Run with custom alert webhook
ALERT_WEBHOOK=https://hooks.slack.com/... docker compose up -d

# Scale workers
docker compose up -d --scale worker-1=3
```

## File structure

```
watchdog/
  master/
    server.js       — master server (~200 lines)
    Dockerfile
  worker/
    worker.js       — worker (~80 lines)
    Dockerfile
  website/
    index.html      — landing page
  docker-compose.yml
  CLAUDE.md
  README.md
```
