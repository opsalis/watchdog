# Architecture — Watchdog

## Overview

Watchdog is a decentralized uptime monitoring service that checks endpoints simultaneously from 4 continents using k3s infrastructure.

## System Components

### 1. API Server (Deployment)
- Single Express.js instance
- SQLite database for monitors, checks, and alerts
- REST API for CRUD operations on monitors
- Serves status page data
- Manages alert state machine (UP/DOWN transitions)

### 2. Checker Nodes (DaemonSet)
- Runs on every k3s node automatically
- Polls API server for assigned monitors on schedule
- Performs HTTP/HTTPS/TCP/DNS checks
- Reports results back to API server
- Tagged with geographic location from node labels

### 3. Website (Cloudflare Pages)
- Static landing page
- Public shareable status dashboard
- No server-side rendering needed

## Data Flow

```
1. Customer creates monitor via API
2. Scheduler determines when each monitor is due
3. All checker nodes receive check assignments
4. Each node performs the check independently
5. Results posted back to API server
6. API server evaluates consensus (majority rule)
7. If state changes: fire alerts (webhook/email/Telegram)
8. Results available via API and status page
```

## Geographic Distribution

| Node | Location | Continent |
|------|----------|-----------|
| k3s-ca | Canada | North America |
| k3s-sg | Singapore | Asia |
| k3s-de | Frankfurt | Europe |
| k3s-uk | United Kingdom | Europe |

## Check Types

| Type | Method | Metrics |
|------|--------|---------|
| HTTP/HTTPS | GET/POST with configurable headers | Status code, response time, body match |
| TCP | Socket connect | Connect time, port open/closed |
| DNS | Resolve hostname | Resolution time, resolved IPs |
| SSL | TLS handshake | Certificate validity, days until expiry |

## Consensus Algorithm

A monitor is marked DOWN only when the majority of checking locations report failure:
- 4 locations: need 3+ failures = DOWN
- 3 locations: need 2+ failures = DOWN
- 2 locations: need 2 failures = DOWN
- 1 location: need 1 failure = DOWN

This prevents false positives from transient network issues at a single location.

## Alert State Machine

```
         check passes
    ┌──────────────────┐
    │                  ▼
  [DOWN] ──────────> [UP]
    ▲                  │
    │                  │
    └──────────────────┘
         check fails
         (majority consensus)
```

Alerts fire ONLY on state transitions, never on repeated same-state checks.

## Storage

SQLite with WAL mode for concurrent reads:
- `monitors` — target URLs, check config, owner
- `checks` — individual check results per location
- `incidents` — state transitions with timestamps
- `api_keys` — authentication

## Security

- API key authentication on all endpoints
- Rate limiting on monitor creation
- No customer data leaves the system
- USDC payments only (no credit card PII)
