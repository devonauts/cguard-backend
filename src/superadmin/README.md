# SuperAdmin Module - Enterprise SaaS Administration Portal

## Overview

The SuperAdmin module provides enterprise-grade platform administration capabilities for multi-tenant SaaS applications. It includes comprehensive tools for monitoring, analyzing, and managing your platform.

## Features

### 1. API Metrics & Analytics
- Real-time request tracking
- Response time monitoring (avg, P95, P99)
- Error rate calculation
- Per-tenant usage analytics
- Time series data for visualization
- Slow request detection

### 2. Query Performance Analysis
- Database query tracking
- Slow query detection
- N+1 query pattern detection
- Query pattern analysis
- Index suggestions
- Query complexity scoring

### 3. Data Integrity Monitoring
- Orphaned record detection
- Missing tenant ID detection
- Broken foreign key detection
- Cross-tenant inconsistency checks
- Integrity score calculation
- Automated cleanup (with confirmation)

### 4. Centralized Error Tracking
- Full stack trace capture
- Error fingerprinting
- Error pattern detection
- Severity classification
- Tenant attribution
- Alert generation

### 5. Tenant Management
- Tenant listing with analytics
- Tenant CRUD operations
- Usage monitoring
- Suspension/reactivation
- Data export (GDPR compliance)
- Tenant deletion with cascade

### 6. System Health Monitoring
- Database connection pool status
- Memory and CPU metrics
- Event loop lag detection
- Service health checks
- Performance benchmarks

## Installation

### 1. Copy the SuperAdmin Module

```bash
# Copy the superadmin folder to your project
cp -r /tmp/cguard-superadmin /path/to/cguard-backend/src/superadmin
```

### 2. Install Dependencies

```bash
npm install uuid
```

### 3. Environment Variables

Add to your `.env` file:

```env
# SuperAdmin Configuration
SUPERADMIN_API_KEY=your-secure-api-key-min-32-chars
SUPERADMIN_SECRET=your-jwt-secret-for-superadmin
SUPERADMIN_IP_WHITELIST=127.0.0.1,192.168.1.0/24

# Optional
SUPERADMIN_RATE_LIMIT=100
SUPERADMIN_RATE_WINDOW_MS=60000
```

### 4. Initialize in Your Application

```typescript
// src/app.ts or src/index.ts
import express from 'express';
import { Sequelize } from 'sequelize';
import { 
  initializeSuperAdmin, 
  SuperAdminRouter,
  requestTrackingMiddleware,
  errorTrackingMiddleware,
} from './superadmin';
import models from './database/models';

const app = express();

// Initialize SuperAdmin with your Sequelize instance
initializeSuperAdmin(sequelize, models);

// Add request tracking middleware (before routes)
app.use(requestTrackingMiddleware);

// Your routes...
app.use('/api', apiRouter);

// Mount SuperAdmin routes
app.use('/superadmin', SuperAdminRouter);

// Add error tracking middleware (after routes)
app.use(errorTrackingMiddleware);
```

### 5. Configure Sequelize Query Logging

```typescript
// src/database/models/index.ts
import { createQueryLogger } from '../superadmin/hooks/SequelizeQueryLogger';

const sequelize = new Sequelize({
  // ...your config
  logging: createQueryLogger({
    enabled: true,
    logToConsole: process.env.NODE_ENV !== 'production',
    slowQueryThreshold: 100, // ms
  }),
  benchmark: true, // Required for timing
});
```

## API Endpoints

### Authentication
All superadmin endpoints require authentication via:
- API Key: `X-SuperAdmin-Api-Key` header
- OR JWT: `Authorization: Bearer <token>` with superadmin role

### Dashboard
```
GET /superadmin/dashboard
```
Returns overview metrics including tenant count, system status, API metrics, and errors.

### API Metrics
```
GET /superadmin/metrics                    # Get detailed API metrics
GET /superadmin/metrics/timeseries         # Time series data for charts
GET /superadmin/metrics/slow-requests      # Get slow requests
GET /superadmin/metrics/tenant/:tenantId   # Tenant-specific metrics
```

### Query Analytics
```
GET  /superadmin/queries                   # Query analytics
GET  /superadmin/queries/slow              # Slow queries list
POST /superadmin/queries/analyze           # Analyze specific query
```

### Data Integrity
```
GET  /superadmin/integrity                 # Last scan report
POST /superadmin/integrity/scan            # Run full scan
GET  /superadmin/integrity/orphans         # Quick orphan scan
POST /superadmin/integrity/cleanup/:table  # Cleanup (dry run by default)
```

### Error Tracking
```
GET  /superadmin/errors                    # Error statistics
GET  /superadmin/errors/recent             # Recent errors
GET  /superadmin/errors/patterns           # Error patterns
GET  /superadmin/errors/fingerprint/:id    # Errors by fingerprint
POST /superadmin/errors/resolve/:id        # Mark pattern resolved
GET  /superadmin/errors/alerts             # Active alerts
```

### Tenant Management
```
GET    /superadmin/tenants                 # List tenants
GET    /superadmin/tenants/stats           # Global statistics
GET    /superadmin/tenants/:id             # Tenant details
POST   /superadmin/tenants                 # Create tenant
PUT    /superadmin/tenants/:id             # Update tenant
POST   /superadmin/tenants/:id/suspend     # Suspend tenant
POST   /superadmin/tenants/:id/reactivate  # Reactivate tenant
DELETE /superadmin/tenants/:id?confirm=true # Delete tenant
GET    /superadmin/tenants/:id/export      # Export tenant data
GET    /superadmin/tenants/:id/errors      # Tenant errors
```

### System Health
```
GET /superadmin/health                     # Full health report
GET /superadmin/health/database            # Database health
GET /superadmin/health/system              # System metrics
```

### Audit
```
GET /superadmin/audit-log                  # Admin audit log
```

## Security Best Practices

1. **API Key Management**
   - Use long, random API keys (32+ characters)
   - Rotate keys periodically
   - Store keys securely (not in code)

2. **IP Whitelisting**
   - Restrict access to known admin IPs
   - Use VPN for remote access

3. **Rate Limiting**
   - Default: 100 requests/minute
   - Customize for your needs

4. **Audit Logging**
   - All superadmin actions are logged
   - Review logs regularly

5. **Permission System**
   - Role-based access control
   - Least privilege principle

## Available Permissions

- `view_dashboard` - View dashboard overview
- `view_metrics` - View API metrics
- `view_queries` - View query analytics
- `view_integrity` - View data integrity reports
- `manage_integrity` - Run scans and cleanups
- `view_errors` - View error tracking
- `manage_errors` - Resolve errors
- `view_tenants` - View tenant list
- `manage_tenants` - Create/update/suspend tenants
- `delete_tenants` - Delete tenants
- `export_data` - Export tenant data
- `view_health` - View system health
- `view_audit` - View audit logs

## Example Usage

### Authenticate with API Key

```bash
curl -X GET \
  https://api.example.com/superadmin/dashboard \
  -H "X-SuperAdmin-Api-Key: your-api-key"
```

### Get Dashboard Data

```bash
curl -X GET \
  https://api.example.com/superadmin/dashboard \
  -H "X-SuperAdmin-Api-Key: your-api-key"
```

### List Tenants with Search

```bash
curl -X GET \
  "https://api.example.com/superadmin/tenants?search=acme&status=active&page=1&limit=20" \
  -H "X-SuperAdmin-Api-Key: your-api-key"
```

### Run Integrity Scan

```bash
curl -X POST \
  https://api.example.com/superadmin/integrity/scan \
  -H "X-SuperAdmin-Api-Key: your-api-key"
```

### Get Error Statistics

```bash
curl -X GET \
  "https://api.example.com/superadmin/errors?minutes=60" \
  -H "X-SuperAdmin-Api-Key: your-api-key"
```

## Architecture

```
superadmin/
├── index.ts                              # Module exports and initialization
├── SuperAdminController.ts               # API routes
├── middleware/
│   ├── SuperAdminAuthMiddleware.ts       # Authentication & authorization
│   └── RequestTrackingMiddleware.ts      # Request/response tracking
├── services/
│   ├── ApiMetricsService.ts              # API analytics
│   ├── QueryAnalyzerService.ts           # Database query analysis
│   ├── OrphanDetectorService.ts          # Data integrity
│   ├── ErrorTrackingService.ts           # Error management
│   ├── TenantManagementService.ts        # Tenant lifecycle
│   └── SystemHealthService.ts            # Health monitoring
└── hooks/
    └── SequelizeQueryLogger.ts           # Query logging
```

## Performance Considerations

1. **In-Memory Storage**
   - Metrics stored in memory with configurable limits
   - Auto-cleanup of old data
   - Consider persistence for production (Redis, TimescaleDB)

2. **Data Limits**
   - Default 50,000 metric records
   - Default 100,000 error records
   - Configurable retention periods

3. **Async Operations**
   - Integrity scans run async
   - Use background jobs for large exports

## Production Recommendations

1. Add persistent storage for metrics (Redis/TimescaleDB)
2. Set up alerting integrations (PagerDuty, Slack)
3. Create a web dashboard for visualization
4. Configure backup for audit logs
5. Set up monitoring for the superadmin endpoints themselves

## Support

For issues or questions, contact the platform team.
