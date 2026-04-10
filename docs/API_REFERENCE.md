# API Reference — Watchdog

Base URL: `https://api.watchdog.example.com`

## Authentication

All requests require an `X-API-Key` header (except public status endpoints).

```
X-API-Key: your-api-key
```

## Endpoints

### Health Check

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "monitors": 42,
  "total_checks": 128456,
  "uptime": 86400
}
```

---

### Create Monitor

```
POST /v1/monitors
```

Body:
```json
{
  "url": "https://example.com",
  "name": "My Website",
  "type": "http",
  "method": "GET",
  "interval_seconds": 60,
  "timeout_ms": 10000,
  "expect_status": 200,
  "expect_body": "OK",
  "locations": ["canada", "singapore", "frankfurt", "uk"],
  "alert_channels": ["webhook", "email", "telegram"],
  "webhook_url": "https://hooks.slack.com/...",
  "alert_email": "ops@company.com",
  "telegram_chat_id": "-1001234567890"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | — | URL to monitor |
| `name` | string | No | null | Display name |
| `type` | string | No | `http` | `http`, `https`, `tcp`, `dns`, `ssl` |
| `method` | string | No | `GET` | HTTP method |
| `interval_seconds` | integer | No | 300 | Check interval (min 30 for Business) |
| `timeout_ms` | integer | No | 10000 | Request timeout |
| `expect_status` | integer | No | 200 | Expected HTTP status code |
| `expect_body` | string | No | null | Expected string in response body |
| `locations` | string[] | No | [] | Specific locations (empty = all) |
| `alert_channels` | string[] | No | [] | `webhook`, `email`, `telegram` |
| `webhook_url` | string | No | null | Webhook URL for alerts |
| `alert_email` | string | No | null | Email for alerts |
| `telegram_chat_id` | string | No | null | Telegram chat ID |

Response: `201 Created`
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "url": "https://example.com",
  "name": "My Website",
  "type": "http",
  "status": "unknown",
  "interval_seconds": 60,
  "created_at": "2026-04-09T12:00:00Z",
  "active": 1
}
```

---

### List Monitors

```
GET /v1/monitors
```

Response:
```json
{
  "monitors": [
    {
      "id": "...",
      "url": "https://example.com",
      "name": "My Website",
      "status": "up",
      "type": "http",
      "interval_seconds": 60,
      "last_checked_at": "2026-04-09T12:05:00Z"
    }
  ]
}
```

---

### Get Monitor

```
GET /v1/monitors/:id
```

Response includes monitor details, recent checks, and recent incidents.

---

### Delete Monitor

```
DELETE /v1/monitors/:id
```

Response:
```json
{ "deleted": true }
```

---

### Get Check History

```
GET /v1/monitors/:id/checks?limit=100
```

Response:
```json
{
  "checks": [
    {
      "id": 1,
      "monitor_id": "...",
      "location": "canada",
      "up": 1,
      "status_code": 200,
      "latency_ms": 145.3,
      "ssl_valid": 1,
      "ssl_days_left": 89,
      "error": null,
      "checked_at": "2026-04-09T12:05:00Z"
    }
  ]
}
```

---

### Get Incidents

```
GET /v1/monitors/:id/incidents?limit=50
```

Response:
```json
{
  "incidents": [
    {
      "id": 1,
      "monitor_id": "...",
      "type": "outage",
      "from_status": "up",
      "to_status": "down",
      "locations": "[\"singapore\"]",
      "started_at": "2026-04-09T10:00:00Z",
      "resolved_at": "2026-04-09T10:05:00Z"
    }
  ]
}
```

---

### Public Status (No Auth Required)

```
GET /v1/status/:id
```

Returns public-safe monitor status for embedding in status pages.

## Webhook Payload

When a state transition occurs, Watchdog POSTs:

```json
{
  "event": "monitor.down",
  "monitor_id": "...",
  "monitor_name": "My Website",
  "url": "https://example.com",
  "status": "down",
  "locations": ["singapore", "canada"],
  "timestamp": "2026-04-09T12:00:00Z"
}
```

Events: `monitor.down`, `monitor.up`

## Rate Limits

| Tier | Monitor creation | API calls |
|------|-----------------|-----------|
| Free | 5 total | 100/hour |
| Pro | 50 total | 1,000/hour |
| Business | 500 total | 10,000/hour |

## Error Responses

All errors follow:
```json
{
  "error": "Description of what went wrong"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing or invalid parameters) |
| 401 | Invalid or missing API key |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
