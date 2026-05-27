# Backend Destructive Reset Runbook

This runbook is for a full backend DB reset when you intentionally want to wipe data and rebuild schema.

## Scope
- Repository: backend
- Environment: local or server
- Impact: destructive (data loss)

## 0) Preconditions
1. Confirm you really want a destructive reset.
2. Ensure `.env` points to the intended database.
3. Take a backup before dropping data.

## 1) Backup (required)
Run from backend root:

```bash
mysqldump -h "$DATABASE_HOST" -P "${DATABASE_PORT:-3306}" -u "$DATABASE_USERNAME" -p"$DATABASE_PASSWORD" "$DATABASE_DATABASE" > backups/pre-reset-$(date +%F-%H%M%S).sql
```

If `mysqldump` is not installed, install MySQL client tools first.

## 2) Stop app processes
```bash
pm2 stop cguard-backend
```

## 3) Drop and recreate database
Example (MySQL):

```bash
mysql -h "$DATABASE_HOST" -P "${DATABASE_PORT:-3306}" -u "$DATABASE_USERNAME" -p"$DATABASE_PASSWORD" -e "DROP DATABASE IF EXISTS \`$DATABASE_DATABASE\`; CREATE DATABASE \`$DATABASE_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

## 4) Rebuild schema + run all migrations + verify
From backend root, run the canonical bootstrap command:

```bash
npm run db:fresh
```

What this does:
1. Builds TypeScript.
2. Creates base tables from Sequelize models.
3. Runs TS/JS migrations.
4. Runs SQL migrations.
5. Verifies DB schema against models and fails if mismatched.

## 5) Start application
```bash
pm2 start ecosystem.config.js --env production
```

Or if already registered in PM2:

```bash
pm2 restart cguard-backend
```

## 6) Post-reset validation
1. Verify schema explicitly:

```bash
npm run db:verify
```

2. Smoke-test critical endpoints:
- `GET /api/tenant/:tenantId/client-account?limit=25&filter[active]=1`
- `GET /api/tenant/:tenantId/security-guard?limit=10`
- `GET /api/tenant/:tenantId/station?limit=10`

3. Check PM2 logs for SQL errors:

```bash
pm2 logs cguard-backend --lines 200 --nostream
```

## Safe deploy hook (already configured)
PM2 `post-deploy` now runs:
1. build
2. TS/JS migrations
3. SQL migrations
4. schema verification
5. PM2 reload

If verification fails, reload is not executed.
