# Business Plan — Watchdog

## Product

Decentralized uptime monitoring from 4 continents simultaneously.

## Market

The uptime monitoring market is $2.5B+ and growing. Key competitors:
- **Pingdom** — $15/mo starting, owned by SolarWinds
- **UptimeRobot** — Free tier + $7/mo, single-region free checks
- **Better Uptime** — $20/mo, modern UI
- **Checkly** — $40/mo, developer-focused

## Differentiation

1. **4 continents simultaneously** — Most competitors check from 1-3 locations
2. **Regional outage detection** — Detect when a site is down in Asia but up in Europe
3. **USDC payment** — No credit card, no chargebacks, crypto-native
4. **Cheaper** — $10/mo for 50 monitors vs $15-40/mo from competitors
5. **Public status pages** — Shareable dashboards included

## Pricing

| Tier | Monitors | Interval | Locations | Price |
|------|----------|----------|-----------|-------|
| Free | 5 | 5 min | 2 | $0/mo |
| Pro | 50 | 1 min | All 4 | $10/mo USDC |
| Business | 500 | 30 sec | All 4 | $50/mo USDC |

## Revenue Model

- Subscription payments in USDC
- 95% to operator, 5% Opsalis settlement
- No refunds (prepaid model)

## Target Customers

1. **DevOps teams** needing multi-region monitoring
2. **SaaS companies** with global users
3. **Crypto/Web3 projects** preferring USDC payment
4. **Agencies** managing multiple client sites

## Go-to-Market

1. Launch on Sertone marketplace
2. Free tier drives adoption
3. API-first for CI/CD integration
4. Public status pages as viral loop

## Cost Structure

- Infrastructure: k3s nodes (shared with other Opsalis services)
- Domain: ~$10/year
- Cloudflare: Free tier
- Variable cost per check: negligible (HTTP requests)

## Metrics to Track

- Monitors created (free vs paid)
- Checks per day
- Alert accuracy (false positive rate)
- Upgrade conversion rate
