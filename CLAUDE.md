# CLAUDE.md — Watchdog

> Read this first. All facts here are traceable to source code.

## What is Watchdog

Decentralized uptime monitoring service. Checks run simultaneously from 4 continents (Canada, Singapore, Frankfurt, UK) via k3s DaemonSet.

- Monitors HTTP/HTTPS/TCP/DNS endpoints from multiple geographic locations
- Detects regional outages (site down in Asia but up in Europe)
- Alerts via webhook, email (Resend), and Telegram on state transitions
- Public shareable status pages per monitor

## Relationship to Opsalis

This project runs on the Opsalis network as an independent business.
It registers its monitoring API via the Opsalis wrapper, earns USDC via the 95/5 settlement model.
No changes to Opsalis core required.

## Repository Structure

```
backend/
  index.ts          — Express API server (create monitors, get results, webhooks)
  checker.ts        — HTTP/HTTPS/TCP/DNS/ICMP checks from multiple locations
  scheduler.ts      — Cron-like scheduler for check intervals
  alerting.ts       — Alert via webhook, email (Resend), Telegram
  package.json
  tsconfig.json
  Dockerfile
  k8s/
    daemonset.yaml  — Checker runs on ALL k3s nodes (geographic distribution)
    deployment.yaml — API server (single instance)
    service.yaml

website/
  index.html        — Landing page: "Monitor from 4 continents"
  dashboard.html    — Public shareable status page
  terms.html
  wrangler.toml

docs/
  API_REFERENCE.md
  DEPLOYMENT.md
```

## Tech Stack

- Runtime: Node.js 22 + TypeScript
- Framework: Express 4
- Database: SQLite (better-sqlite3)
- Orchestration: k3s DaemonSet (checker) + Deployment (API)
- Website: Cloudflare Pages

## Architecture

```
                    ┌─────────────────┐
                    │   API Server    │  Express :3300 + SQLite
                    │  (Deployment)   │
                    └────────┬────────┘
                             │ Internal HTTP
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │ Checker Node │ │ Checker Node │ │ Checker Node │
     │  (Canada)    │ │  (Frankfurt) │ │ (Singapore)  │ ...
     │  DaemonSet   │ │  DaemonSet   │ │  DaemonSet   │
     └──────────────┘ └──────────────┘ └──────────────┘
```

## Key Design Decisions

- **DaemonSet for geographic distribution.** Checker runs on every k3s node automatically.
- **API server is the single source of truth.** Checkers poll the API for their assigned monitors.
- **Alerts are edge-triggered.** Webhook fires only on UP→DOWN or DOWN→UP transitions.
- **Multi-location consensus.** A site is only marked DOWN if majority of locations agree.
- **SSL certificate monitoring** built-in (expiry warnings at 30/14/7 days).

## Pricing

| Tier | Monitors | Interval | Locations | Price |
|------|----------|----------|-----------|-------|
| Free | 5 | 5 min | 2 | $0 |
| Pro | 50 | 1 min | All 4 | $10/mo USDC |
| Business | 500 | 30 sec | All 4 | $50/mo USDC |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3300` | API listen port |
| `DB_PATH` | `./data/watchdog.db` | SQLite path |
| `NODE_LOCATION` | `unknown` | Geographic location label |
| `API_URL` | `http://watchdog-api:3300` | Central API URL (for checkers) |
| `RESEND_API_KEY` | — | Email alerts via Resend |
| `TELEGRAM_BOT_TOKEN` | — | Telegram alerts |
| `API_KEY` | — | Authentication key |

## Status

COMPLETE — Full implementation with API, DaemonSet checker, alerting, k8s manifests, and website.

## Repository

https://github.com/opsalis/watchdog
