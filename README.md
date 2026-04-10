# Watchdog — Decentralized Uptime Monitoring

Monitor your websites, APIs, and services from 4 continents simultaneously. Know before your users do.

## Features

- **Multi-continent checks** — Canada, Singapore, Frankfurt, UK
- **Regional outage detection** — Down in Asia but up in Europe? We catch it.
- **Multiple check types** — HTTP, HTTPS, TCP, DNS, SSL certificate
- **Smart alerting** — Webhook, email, Telegram with consensus-based triggers
- **Public status pages** — Share a live dashboard with your users
- **Sub-minute intervals** — Check as often as every 30 seconds

## Quick Start

### Docker Compose (Development)

```bash
docker compose up -d
```

### API Usage

```bash
# Create a monitor
curl -X POST http://localhost:3300/v1/monitors \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-key' \
  -d '{
    "url": "https://example.com",
    "type": "http",
    "interval_seconds": 60,
    "alert_channels": ["webhook"],
    "webhook_url": "https://your-webhook.com/alert"
  }'

# List monitors
curl http://localhost:3300/v1/monitors \
  -H 'X-API-Key: your-key'

# Get check results
curl http://localhost:3300/v1/monitors/{id}/checks \
  -H 'X-API-Key: your-key'

# Health check
curl http://localhost:3300/health
```

## Architecture

```
API Server (Deployment)          Checker Nodes (DaemonSet)
┌──────────────────┐     ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Express + SQLite  │◄───│ Canada   │ │ Frankfurt│ │Singapore │
│ REST API :3300    │    │  Checker │ │  Checker │ │  Checker │
│ Alert Engine      │    └──────────┘ └──────────┘ └──────────┘
└──────────────────┘
```

## Deployment

### k3s (Production)

```bash
kubectl apply -f backend/k8s/service.yaml
kubectl apply -f backend/k8s/deployment.yaml
kubectl apply -f backend/k8s/daemonset.yaml
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | API listen port |
| `DB_PATH` | `./data/watchdog.db` | SQLite database path |
| `NODE_LOCATION` | `unknown` | Geographic location label |
| `API_URL` | `http://watchdog-api:3300` | Central API (for checkers) |
| `API_KEY` | — | Authentication key |
| `RESEND_API_KEY` | — | Email alerts |
| `TELEGRAM_BOT_TOKEN` | — | Telegram alerts |

## Pricing

| Tier | Monitors | Interval | Locations | Price |
|------|----------|----------|-----------|-------|
| Free | 5 | 5 min | 2 | $0 |
| Pro | 50 | 1 min | All 4 | $10/mo USDC |
| Business | 500 | 30 sec | All 4 | $50/mo USDC |

## License

Proprietary — Mesa Operations LLC
