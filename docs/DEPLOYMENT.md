# Deployment Guide — Watchdog

## Prerequisites

- k3s cluster with nodes in multiple regions
- kubectl configured
- Docker for building images
- Cloudflare account (for website)

## 1. Build Docker Images

```bash
cd backend

# Build API server image
docker build -t opsalis/watchdog-api:latest .

# Build checker image (same Dockerfile, different CMD)
docker build -t opsalis/watchdog-checker:latest .

# Push to registry
docker push opsalis/watchdog-api:latest
docker push opsalis/watchdog-checker:latest
```

## 2. Create Namespace and Secrets

```bash
kubectl create namespace watchdog

kubectl create secret generic watchdog-secrets -n watchdog \
  --from-literal=api-key=YOUR_API_KEY \
  --from-literal=resend-api-key=YOUR_RESEND_KEY \
  --from-literal=telegram-bot-token=YOUR_TELEGRAM_TOKEN
```

## 3. Deploy to k3s

```bash
# Create service and namespace
kubectl apply -f backend/k8s/service.yaml

# Deploy API server
kubectl apply -f backend/k8s/deployment.yaml

# Deploy checker DaemonSet (runs on all nodes)
kubectl apply -f backend/k8s/daemonset.yaml
```

## 4. Verify Deployment

```bash
# Check pods
kubectl get pods -n watchdog

# Check DaemonSet (should show one pod per node)
kubectl get daemonset -n watchdog

# Check API health
kubectl port-forward -n watchdog svc/watchdog-api 3300:3300
curl http://localhost:3300/health
```

## 5. Node Labels

Ensure k3s nodes have location labels:

```bash
kubectl label node k3s-ca region=americas location=canada
kubectl label node k3s-de region=europe location=frankfurt
kubectl label node k3s-uk region=europe location=uk
kubectl label node k3s-sg region=asia location=singapore
```

## 6. Deploy Website

```bash
cd website

# Using Cloudflare Pages
npx wrangler pages deploy . --project-name=watchdog-website

# Or push to GitHub and connect via Cloudflare dashboard
```

## 7. Domain Setup

1. Register domain (see DOMAINS_TODO.md)
2. Add domain to Cloudflare
3. Create DNS records:
   - `@` -> Cloudflare Pages
   - `api` -> k3s ingress IP
4. Update wrangler.toml with actual domain
5. Update k8s ingress with actual domain

## Monitoring the Monitor

```bash
# Watch checker logs
kubectl logs -n watchdog -l component=checker -f

# Watch API logs
kubectl logs -n watchdog -l component=api -f

# Check DaemonSet rollout
kubectl rollout status daemonset/watchdog-checker -n watchdog
```

## Updating

```bash
# Build new images
docker build -t opsalis/watchdog-api:v1.1.0 backend/
docker push opsalis/watchdog-api:v1.1.0

# Update deployment
kubectl set image deployment/watchdog-api -n watchdog api=opsalis/watchdog-api:v1.1.0
kubectl set image daemonset/watchdog-checker -n watchdog checker=opsalis/watchdog-checker:v1.1.0
```

## Backup

SQLite database is stored in a PersistentVolumeClaim. Back up regularly:

```bash
kubectl exec -n watchdog deployment/watchdog-api -- sqlite3 /app/data/watchdog.db ".backup /tmp/backup.db"
kubectl cp watchdog/$(kubectl get pod -n watchdog -l component=api -o jsonpath='{.items[0].metadata.name}'):/tmp/backup.db ./watchdog-backup.db
```
