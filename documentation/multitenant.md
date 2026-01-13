# Multi‑tenant Mode

This project supports both single‑tenant and multi‑tenant modes.

## How to enable multi‑tenant

- By default `npm start` now runs the app in multi‑tenant mode (`TENANT_MODE=multi`). You can still override the mode via `.env` or by using the multi scripts.

```bash
npm start             # development (nodemon + ts-node) in multi mode by default
npm run dev:multi     # explicit multi mode (same as npm start)
npm run start:multi   # production (built dist) in multi mode
```

## Selecting tenant per request

- Routes already use `:tenantId` in the path for tenant scoped resources, e.g. `/api/tenant/:tenantId/tax`.
- Additionally, the server accepts `X-Tenant-Id` header. If present it will set `req.currentTenant` based on that id and validate the current user's membership in that tenant.

## Security

- When using `X-Tenant-Id` the middleware validates the current user's membership before setting the tenant.

## Notes

- If you want subdomain-based tenant selection, we can implement that later.
