# Ops activation checklist (all local — your own server, no cloud)

Everything below is BUILT + DEPLOYED and runs entirely on your server.

## ✅ Active now (no action needed)
- **DB connection pool** — `DATABASE_POOL_MAX=50`.
- **Off-panel alerting → email** — `ALERT_EMAIL_TO=michaelurrestap@gmail.com`.
  Threshold breaches (disk/RAM/heap/pool/error-spike/job-failure) email you.
- **Health endpoints** — `GET /api/health`, `/api/health/ready`, `/api/health/live`.
- **Prometheus metrics** — `GET /api/metrics` (Bearer `METRICS_TOKEN`).
- **Local DB backups** — daily leader-elected mysqldump→gzip→rotate(14) to
  `~/db-backups`. Superadmin ▸ Observability ▸ Copias. Files stay on YOUR disk.
- **File uploads** — stored on local disk (`UPLOAD_DIR`, default `./uploads`).

## Optional (still all local)
- **Second-copy backups on another disk/mount** — protects against a single disk
  failing. Point at any second local path (a second drive, a NAS mount, etc.):
  ```
  BACKUP_MIRROR_DIR=/mnt/backup2/cguard    # any local/mounted path you control
  ```
  Each dump is copied there and rotated too. No cloud involved.
- **Extra alert channels**:
  ```
  ALERT_SLACK_WEBHOOK=...      # if you run Slack/Mattermost
  ALERT_SMS_TO=+593...         # via the existing Twilio/comms layer
  ```
- **Self-hosted uptime check** — if you want an outside-the-process watcher, run a
  cron on another machine on your LAN: `curl -fsS http://<server>/api/health`.
