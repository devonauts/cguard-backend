/**
 * Unit tests — KPI actuals, dashboard stats, guard ratings (client-scoped) and
 * department-settings delete guard.
 *
 * Covered (REAL production code, fake in-memory db):
 *   - computeKpiActuals               real activity counts scoped by guard /
 *                                     post-site + KPI calendar-month window
 *                                     (incident / task / route), tenant-scoped
 *   - DashboardService                getClientPortfolioStats categorization +
 *                                     client dedup; getIncidentTypeStats mapping;
 *                                     getAllDashboardStats resilience + caching
 *   - guardRatingList handler         tenant scope, guardId filter, average calc,
 *                                     name mapping, permission gate (403)
 *   - guardRatingSummary handler      per-guard aggregate shaping + Op.in filter
 *   - departmentDestroy handler       in-use guard (400), soft delete, tenant 404,
 *                                     permission gate (403)
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rbac-settings-kpis/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import computeKpiActuals from '../../../src/database/repositories/kpiActuals';
import DashboardService from '../../../src/services/dashboardService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';

import guardRatingList from '../../../src/api/guardRating/guardRatingList';
import guardRatingSummary from '../../../src/api/guardRating/guardRatingSummary';
import departmentDestroy from '../../../src/api/department/departmentDestroy';

import { buildDb, repoOptions, fakeReq, fakeRes, adminUser, userWithRoles } from './helpers';

const TENANT = 'tenant-kpi-A';
const OTHER = 'tenant-kpi-B';

// ═══════════════════ computeKpiActuals (KPI actuals from real data) ══════════
describe('op-kpi · computeKpiActuals', () => {
  // KPI period = the calendar month of createdAt. Use March 2026.
  const inMonth = new Date('2026-03-15T12:00:00Z');
  const prevMonth = new Date('2026-02-15T12:00:00Z');

  it('guard scope: counts only this-month, this-guard, this-tenant activity', async () => {
    const db = buildDb({
      incident: [
        { id: 'i1', tenantId: TENANT, guardNameId: 'sg-1', createdAt: inMonth, deletedAt: null }, // counted
        { id: 'i2', tenantId: TENANT, guardNameId: 'sg-2', createdAt: inMonth, deletedAt: null }, // other guard
        { id: 'i3', tenantId: TENANT, guardNameId: 'sg-1', createdAt: prevMonth, deletedAt: null }, // prev month
        { id: 'i4', tenantId: OTHER, guardNameId: 'sg-1', createdAt: inMonth, deletedAt: null }, // other tenant
      ],
      task: [
        { id: 't1', tenantId: TENANT, completedByGuardId: 'sg-1', status: 'completed', dateCompletedTask: inMonth, deletedAt: null }, // counted
        { id: 't2', tenantId: TENANT, completedByGuardId: 'sg-1', status: 'pending', dateCompletedTask: inMonth, deletedAt: null }, // wrong status
        { id: 't3', tenantId: TENANT, completedByGuardId: 'sg-2', status: 'approved', dateCompletedTask: inMonth, deletedAt: null }, // other guard
      ],
      tagScan: [
        { id: 'ts1', tenantId: TENANT, securityGuardId: 'sg-1', scannedAt: inMonth, deletedAt: null }, // counted
        { id: 'ts2', tenantId: TENANT, securityGuardId: 'sg-2', scannedAt: inMonth, deletedAt: null }, // other guard
      ],
    });
    const kpi = { scope: 'guard', guardId: 'sg-1', createdAt: inMonth };
    const out = await computeKpiActuals(db, kpi, TENANT);
    assert.strictEqual(out.incident, 1, 'incident actual wrong');
    assert.strictEqual(out.task, 1, 'task actual wrong');
    assert.strictEqual(out.route, 1, 'route actual wrong');
  });

  it('postSite scope: incident by postSiteId, route via resolved stations, task=null', async () => {
    const db = buildDb({
      incident: [
        { id: 'i1', tenantId: TENANT, postSiteId: 'ps-1', createdAt: inMonth, deletedAt: null },
        { id: 'i2', tenantId: TENANT, postSiteId: 'ps-2', createdAt: inMonth, deletedAt: null }, // other post
      ],
      station: [
        { id: 'st-1', tenantId: TENANT, postSiteId: 'ps-1', deletedAt: null },
        { id: 'st-9', tenantId: TENANT, postSiteId: 'ps-2', deletedAt: null },
      ],
      tagScan: [
        { id: 'ts1', tenantId: TENANT, stationId: 'st-1', scannedAt: inMonth, deletedAt: null }, // counted
        { id: 'ts2', tenantId: TENANT, stationId: 'st-9', scannedAt: inMonth, deletedAt: null }, // other post's station
      ],
    });
    const kpi = { scope: 'postSite', postSiteId: 'ps-1', createdAt: inMonth };
    const out = await computeKpiActuals(db, kpi, TENANT);
    assert.strictEqual(out.incident, 1);
    assert.strictEqual(out.route, 1, 'route must only count the post-site station scans');
    assert.strictEqual(out.task, null, 'task is not scopable to a post-site → null (hidden)');
  });

  it('postSite scope with NO stations leaves route = null (hidden, not 0)', async () => {
    const db = buildDb({
      incident: [{ id: 'i1', tenantId: TENANT, postSiteId: 'ps-1', createdAt: inMonth, deletedAt: null }],
      tagScan: [{ id: 'ts1', tenantId: TENANT, stationId: 'st-x', scannedAt: inMonth, deletedAt: null }],
    });
    const out = await computeKpiActuals(db, { scope: 'postSite', postSiteId: 'ps-1', createdAt: inMonth }, TENANT);
    assert.strictEqual(out.route, null, 'no stations → route must stay null');
  });

  it('returns all-null when db/tenant/kpi is missing (never throws)', async () => {
    const db = buildDb();
    assert.deepStrictEqual(await computeKpiActuals(null, {}, TENANT), { incident: null, task: null, route: null });
    assert.deepStrictEqual(await computeKpiActuals(db, null, TENANT), { incident: null, task: null, route: null });
    assert.deepStrictEqual(await computeKpiActuals(db, {}, ''), { incident: null, task: null, route: null });
  });
});

// ═══════════════════ DashboardService ════════════════════════════════════════
describe('op-dashboard · DashboardService', () => {
  it('getClientPortfolioStats categorizes clients by serviceType and dedups per client', async () => {
    const t = `${TENANT}-portfolio`;
    const db = buildDb({
      businessInfo: [
        { id: 'b1', tenantId: t, clientAccountId: 'c1', serviceType: 'Residential guard', deletedAt: null },
        { id: 'b2', tenantId: t, clientAccountId: 'c1', serviceType: 'Industrial', deletedAt: null }, // dup client → ignored
        { id: 'b3', tenantId: t, clientAccountId: 'c2', serviceType: 'Industrial plant', deletedAt: null },
        { id: 'b4', tenantId: t, clientAccountId: 'c3', serviceType: 'Government building', deletedAt: null },
        { id: 'b5', tenantId: t, clientAccountId: 'c4', serviceType: 'Retail mall', deletedAt: null }, // → commercial
        { id: 'b6', tenantId: OTHER, clientAccountId: 'c9', serviceType: 'Residential', deletedAt: null }, // other tenant
      ],
    });
    const svc = new DashboardService(repoOptions(db, t));
    const stats = await svc.getClientPortfolioStats();
    const byType: Record<string, number> = {};
    stats.forEach((s: any) => (byType[s.type] = s.count));
    assert.strictEqual(byType.Residential, 1);
    assert.strictEqual(byType.Industrial, 1, 'first serviceType per client wins (dedup)');
    assert.strictEqual(byType.Government, 1);
    assert.strictEqual(byType.Commercial, 1);
  });

  it('getIncidentTypeStats maps wasRead → Resolved/Pending with the aggregate counts', async () => {
    const t = `${TENANT}-inctype`;
    const db = buildDb();
    // The real query is a GROUP BY wasRead COUNT; feed the aggregate-shaped rows.
    db.incident.findAll = async () => [
      { wasRead: true, count: '3' },
      { wasRead: false, count: '2' },
    ];
    const svc = new DashboardService(repoOptions(db, t));
    const stats = await svc.getIncidentTypeStats();
    const byType: Record<string, number> = {};
    stats.forEach((s: any) => (byType[s.type] = s.count));
    assert.strictEqual(byType['Resolved Incidents'], 3);
    assert.strictEqual(byType['Pending Incidents'], 2);
  });

  it('getAllDashboardStats returns all 8 panels and a single failing sub-stat degrades to [] (no 500)', async () => {
    const t = `${TENANT}-all-${Date.now()}`;
    const db = buildDb();
    // Make ONE sub-stat blow up; the panel must still assemble.
    db.billing.findAll = async () => {
      throw new Error('billing table gone');
    };
    const svc = new DashboardService(repoOptions(db, t));
    const payload = await svc.getAllDashboardStats();
    for (const key of [
      'clientAcquisition', 'incidentTypes', 'revenue', 'clientPortfolio',
      'serviceRevenue', 'guardPerformance', 'securityPerformance', 'customerSatisfaction',
    ]) {
      assert.ok(key in payload, `missing dashboard key ${key}`);
    }
    assert.deepStrictEqual(payload.revenue, [], 'failing revenue sub-stat must degrade to []');
  });

  it('getAllDashboardStats is memoized per tenant (second call returns the cached object)', async () => {
    const t = `${TENANT}-cache-${Date.now()}`;
    const db = buildDb();
    const svc = new DashboardService(repoOptions(db, t));
    const first = await svc.getAllDashboardStats();
    const second = await svc.getAllDashboardStats();
    assert.strictEqual(first, second, 'cache must return the same object reference within TTL');
  });
});

// ═══════════════════ guardRatingList handler (client feedback, tenant-scoped) ═
describe('op-ratings · guardRatingList handler', () => {
  function seedRatings() {
    const mk = (id: string, over: any) => ({
      id, tenantId: TENANT, deletedAt: null, createdAt: new Date(),
      guard: { id: over.guardId, fullName: over.guardName || 'Vigilante' },
      client: { id: 'ca-1', commercialName: 'Comercial Andes S.A.' },
      station: { id: 'st-1', stationName: 'Puesto Norte' },
      clientAccountId: 'ca-1', stationId: 'st-1', ...over,
    });
    return buildDb({
      guardRating: [
        mk('r1', { guardId: 'sg-1', rating: 5 }),
        mk('r2', { guardId: 'sg-1', rating: 4 }),
        mk('r3', { guardId: 'sg-1', rating: 3 }),
        mk('r4', { guardId: 'sg-2', rating: 2 }),
        // foreign tenant rating for the same guard — must never appear.
        { id: 'rX', tenantId: OTHER, deletedAt: null, guardId: 'sg-1', rating: 1, createdAt: new Date(), guard: { id: 'sg-1', fullName: 'Ajeno' }, client: null, station: null },
      ],
    });
  }

  it('scoped to the tenant + filtered by guardId; average computed over ONLY those rows', async () => {
    const db = seedRatings();
    const req = fakeReq(db, TENANT, { query: { guardId: 'sg-1' } });
    const res = fakeRes();
    await guardRatingList(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.count, 3, 'only sg-1 rows of this tenant');
    assert.strictEqual(res.body.average, 4, '(5+4+3)/3 = 4');
    assert.ok(res.body.rows.every((r: any) => r.guardId === 'sg-1'));
    const blob = JSON.stringify(res.body);
    assert.ok(!blob.includes('Ajeno'), 'foreign-tenant rating leaked');
    assert.ok(!blob.includes('"rating":2'), 'other-guard rating leaked into the filter');
  });

  it('maps the joined client business name and station name', async () => {
    const db = seedRatings();
    const req = fakeReq(db, TENANT, { query: { guardId: 'sg-1' } });
    const res = fakeRes();
    await guardRatingList(req, res);
    const row = res.body.rows[0];
    assert.strictEqual(row.clientName, 'Comercial Andes S.A.', 'client company name not mapped');
    assert.strictEqual(row.stationName, 'Puesto Norte');
    assert.strictEqual(row.guardName, 'Vigilante');
  });

  it('is denied for a role without securityGuardRead → 403', async () => {
    const db = seedRatings();
    const req = fakeReq(db, TENANT, { currentUser: userWithRoles(['custom'], TENANT), query: {} });
    const res = fakeRes();
    await guardRatingList(req, res);
    assert.strictEqual(res.statusCode, 403);
  });
});

// ═══════════════════ guardRatingSummary handler (per-guard aggregate) ════════
describe('op-ratings · guardRatingSummary handler', () => {
  // The real query is AVG/COUNT GROUP BY guardId; feed aggregate-shaped rows.
  function seedAgg() {
    return buildDb({
      guardRating: [
        { id: 'a1', tenantId: TENANT, guardId: 'sg-1', avg: '4.333', cnt: '3', deletedAt: null },
        { id: 'a2', tenantId: TENANT, guardId: 'sg-2', avg: '5', cnt: '1', deletedAt: null },
        { id: 'a3', tenantId: TENANT, guardId: 'sg-3', avg: '2', cnt: '4', deletedAt: null },
      ],
    });
  }

  it('returns per-guard {average,count}, rounding average to 2 decimals', async () => {
    const db = seedAgg();
    const req = fakeReq(db, TENANT, { query: {} });
    const res = fakeRes();
    await guardRatingSummary(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.summary['sg-1'], { average: 4.33, count: 3 });
    assert.deepStrictEqual(res.body.summary['sg-2'], { average: 5, count: 1 });
  });

  it('the guardIds filter (Op.in) restricts to the requested guards only', async () => {
    const db = seedAgg();
    const req = fakeReq(db, TENANT, { query: { guardIds: 'sg-1,sg-2' } });
    const res = fakeRes();
    await guardRatingSummary(req, res);
    assert.ok(res.body.summary['sg-1']);
    assert.ok(res.body.summary['sg-2']);
    assert.ok(!res.body.summary['sg-3'], 'sg-3 must be filtered out by the guardIds list');
  });
});

// ═══════════════════ departmentDestroy handler (department settings) ══════════
describe('op-settings · departmentDestroy handler', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
  });
  afterEach(() => sinon.restore());

  const seedDept = (extra: any = {}) =>
    buildDb({
      department: [{ id: 'd-1', tenantId: TENANT, name: 'Operaciones', deletedAt: null, ...extra.dept }],
      tenantUser: extra.tenantUser || [],
    });

  it('refuses to delete a department that still has members → 400 (not destroyed)', async () => {
    const db = seedDept({
      tenantUser: [{ id: 'tu-1', tenantId: TENANT, departmentId: 'd-1', status: 'active' }],
    });
    const req = fakeReq(db, TENANT, { params: { tenantId: TENANT, id: 'd-1' } });
    const res = fakeRes();
    await departmentDestroy(req, res);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(db.department.rows[0].__destroyed, false, 'in-use department must survive');
  });

  it('soft-deletes an empty department and echoes its id', async () => {
    const db = seedDept();
    const req = fakeReq(db, TENANT, { params: { tenantId: TENANT, id: 'd-1' } });
    const res = fakeRes();
    await departmentDestroy(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(db.department.rows[0].__destroyed, true);
    assert.strictEqual(res.body.id, 'd-1');
  });

  it("another tenant's department is a 404 (nothing destroyed)", async () => {
    const db = seedDept({ dept: { tenantId: OTHER } });
    const req = fakeReq(db, TENANT, { params: { tenantId: TENANT, id: 'd-1' } });
    const res = fakeRes();
    await departmentDestroy(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(db.department.rows[0].__destroyed, false);
  });

  it('is denied for a non-admin (no settingsEdit) → 403', async () => {
    const db = seedDept();
    const req = fakeReq(db, TENANT, {
      currentUser: userWithRoles(['securityGuard'], TENANT),
      params: { tenantId: TENANT, id: 'd-1' },
    });
    const res = fakeRes();
    await departmentDestroy(req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.department.rows[0].__destroyed, false);
  });
});
