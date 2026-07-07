# Enterprise activation checklist

Everything below is BUILT + DEPLOYED. This lists what's already active vs. what
needs a credential/signup to switch on.

## ✅ Active now (no action needed)
- **DB connection pool** — `DATABASE_POOL_MAX=50` on prod (P0 resolved).
- **Off-panel alerting → email** — `ALERT_EMAIL_TO=michaelurrestap@gmail.com`.
  Threshold breaches (disk/RAM/heap/pool/error-spike/job-failure) email you.
- **Public health endpoints** — `GET /api/health`, `/api/health/ready`, `/api/health/live` (200).
- **Prometheus metrics** — `GET /api/metrics` (Bearer `METRICS_TOKEN`, set on prod).
- **Automated DB backups** — daily leader-elected mysqldump→gzip→rotate(14) to
  `~/db-backups` + boot stale-check. Superadmin ▸ Observability ▸ Copias.

## 🔑 Needs your action to fully close enterprise-readiness

### 1. External uptime monitor (5 min, free)
Sign up for UptimeRobot / BetterStack / Pingdom and monitor:
`https://api.cguardpro.com/api/health` (expect 200). This is the OUTSIDE watcher
the self-hosted panel can't be.

### 2. Off-box backups + uploads → S3 (the last scaling P0)
Create an S3 (or S3-compatible: Backblaze B2 / Cloudflare R2 / Wasabi) bucket +
an IAM key, then in `/home/cguardpro/cguard-backend/.env`:
```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
# off-box DB backups:
BACKUP_S3_BUCKET=cguard-backups
# durable file storage (lets you run >1 box):
FILE_STORAGE_BUCKET=cguard-uploads
FILE_STORAGE_PROVIDER=aws
```
Before flipping `FILE_STORAGE_PROVIDER=aws`, migrate existing files:
```
cd /home/cguardpro/cguard-backend
npx ts-node scripts/migrate-uploads-to-s3.ts --dry   # preview
npx ts-node scripts/migrate-uploads-to-s3.ts          # copy
```
Then reload PM2. (Backups auto-upload off-box as soon as BACKUP_S3_BUCKET is set.)

### 3. Optional extra alert channels
```
ALERT_SLACK_WEBHOOK=https://hooks.slack.com/services/...
ALERT_SMS_TO=+593...            # via the existing Twilio/comms layer
```

### 4. Optional APM
Point Grafana Agent / Datadog OpenMetrics at `/api/metrics` with
`Authorization: Bearer <METRICS_TOKEN>`.
