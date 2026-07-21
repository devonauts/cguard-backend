/**
 * Unit tests — settings persistence + sanitizers (postRules / guardSettings /
 * ronda settings) and the classic "settings PUT erased my logo" null-clobber bug.
 *
 * Covered (REAL production code):
 *   - SettingsRepository.save        partial PUT must NOT wipe logoUrl /
 *                                    backgroundImageUrl (presence-guarded), and
 *                                    persists postRules/guardSettings JSON blobs
 *   - settingsSave handler           settingsEdit gate (403), sanitizes
 *                                    postRules/guardSettings before persisting
 *   - resolvePostRules               boolean-only whitelist
 *   - resolveGuardSettings           key whitelist + numeric clamping
 *   - rondaSettings GET/PUT          per-post override, partial pick (no clobber),
 *                                    upsert, permission gates
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/op-rbac-settings-kpis/**\/*.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import SettingsRepository from '../../../src/database/repositories/settingsRepository';
import SettingsService from '../../../src/services/settingsService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import PermissionChecker from '../../../src/services/user/permissionChecker';

import settingsSave from '../../../src/api/settings/settingsSave';
import rondaSettingsRoutes from '../../../src/api/rondaSettings/index';

import {
  DEFAULT_POST_RULES,
  resolvePostRules,
} from '../../../src/services/postRulesService';
import {
  DEFAULT_GUARD_SETTINGS,
  resolveGuardSettings,
} from '../../../src/services/guardSettingsService';

import { buildDb, repoOptions, fakeReq, fakeRes, adminUser, userWithRoles } from './helpers';

const TENANT = 'tenant-set-A';
const OTHER = 'tenant-set-B';
const USER_ID = 'user-1';

// ═══════════════════ resolvePostRules (sanitizer) ═══════════════════════════
describe('op-settings · resolvePostRules', () => {
  it('coerces every known key to a boolean and ignores unknown keys', () => {
    const out = resolvePostRules({
      requireActiveShiftForRounds: 1,
      geofenceExitAlert: 'yes',
      geofenceReturnAlert: 0,
      injectedGarbage: 'DROP TABLE',
    });
    assert.deepStrictEqual(out, {
      requireActiveShiftForRounds: true,
      geofenceExitAlert: true,
      geofenceReturnAlert: false,
    });
    assert.ok(!('injectedGarbage' in out), 'unknown keys must not survive');
  });

  it('null / non-object input → all defaults', () => {
    assert.deepStrictEqual(resolvePostRules(null), DEFAULT_POST_RULES);
    assert.deepStrictEqual(resolvePostRules('x'), DEFAULT_POST_RULES);
  });
});

// ═══════════════════ resolveGuardSettings (sanitizer + clamp) ════════════════
describe('op-settings · resolveGuardSettings', () => {
  it('clamps inactivityThresholdMin to [10,120] and rounds', () => {
    assert.strictEqual(resolveGuardSettings({ inactivityThresholdMin: 5 }).inactivityThresholdMin, 10);
    assert.strictEqual(resolveGuardSettings({ inactivityThresholdMin: 999 }).inactivityThresholdMin, 120);
    assert.strictEqual(resolveGuardSettings({ inactivityThresholdMin: 33.7 }).inactivityThresholdMin, 34);
  });

  it('clamps licenseExpiryDays to [7,120]', () => {
    assert.strictEqual(resolveGuardSettings({ licenseExpiryDays: 1 }).licenseExpiryDays, 7);
    assert.strictEqual(resolveGuardSettings({ licenseExpiryDays: 500 }).licenseExpiryDays, 120);
  });

  it('non-numeric (NaN) thresholds fall back to the defaults (never NaN)', () => {
    const out = resolveGuardSettings({ inactivityThresholdMin: 'abc', licenseExpiryDays: 'xyz' });
    assert.strictEqual(out.inactivityThresholdMin, DEFAULT_GUARD_SETTINGS.inactivityThresholdMin);
    assert.strictEqual(out.licenseExpiryDays, DEFAULT_GUARD_SETTINGS.licenseExpiryDays);
  });

  // FINDING (low): the clamp uses Number(v), so `null` / '' coerce to 0 (a FINITE
  // number) and get floored to the MIN of the range instead of using the default.
  // A cleared field arrives as the smallest allowed value, not the intended default.
  it('FIXED: un campo LIMPIADO (null/"") usa el DEFAULT, no el mínimo del rango', () => {
    // Number(null)/Number('') son 0 (finitos) → antes se clampaban al mínimo;
    // ahora null/'' significan "usar el default".
    assert.strictEqual(resolveGuardSettings({ inactivityThresholdMin: null }).inactivityThresholdMin,
      DEFAULT_GUARD_SETTINGS.inactivityThresholdMin);
    assert.strictEqual(resolveGuardSettings({ licenseExpiryDays: null }).licenseExpiryDays,
      DEFAULT_GUARD_SETTINGS.licenseExpiryDays);
    assert.strictEqual(resolveGuardSettings({ licenseExpiryDays: '' }).licenseExpiryDays,
      DEFAULT_GUARD_SETTINGS.licenseExpiryDays);
  });

  it('boolean flags: default-true keys stay true unless explicitly false', () => {
    // shiftRemindersEnabled / licenseExpiryAlert default true; only `=== false` flips.
    assert.strictEqual(resolveGuardSettings({}).shiftRemindersEnabled, true);
    assert.strictEqual(resolveGuardSettings({ shiftRemindersEnabled: false }).shiftRemindersEnabled, false);
    assert.strictEqual(resolveGuardSettings({ shiftRemindersEnabled: 0 }).shiftRemindersEnabled, true);
    assert.strictEqual(resolveGuardSettings({ inactivityAlert: true }).inactivityAlert, true);
  });
});

// ═══════════════════ SettingsRepository.save (null-clobber guard) ════════════
describe('op-settings · SettingsRepository.save', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  function seedSettings(extra: any = {}) {
    return buildDb({
      settings: [
        {
          id: TENANT,
          tenantId: TENANT,
          logoUrl: 'https://cdn/logo-original.png',
          backgroundImageUrl: 'https://cdn/bg-original.png',
          theme: 'gold',
          ...extra,
          deletedAt: null,
        },
      ],
    });
  }

  it('a partial PUT that omits logos/backgroundImages does NOT erase logoUrl/backgroundImageUrl', async () => {
    const db = seedSettings();
    // Saving only a JSON blob (a page persisting postRules) — the classic case
    // that used to null the tenant logo.
    await SettingsRepository.save(
      { postRules: { requireActiveShiftForRounds: true, geofenceExitAlert: false, geofenceReturnAlert: false } },
      { ...repoOptions(db, TENANT), transaction: undefined },
    );
    const row = db.settings.rows[0];
    assert.strictEqual(row.logoUrl, 'https://cdn/logo-original.png', 'logoUrl wiped by partial save');
    assert.strictEqual(row.backgroundImageUrl, 'https://cdn/bg-original.png', 'backgroundImageUrl wiped by partial save');
    assert.deepStrictEqual(row.postRules.requireActiveShiftForRounds, true, 'postRules blob not persisted');
  });

  it('sending backgroundImages:[] DOES recompute backgroundImageUrl to null (explicit clear)', async () => {
    const db = seedSettings();
    await SettingsRepository.save(
      { backgroundImages: [] },
      { ...repoOptions(db, TENANT), transaction: undefined },
    );
    const row = db.settings.rows[0];
    assert.strictEqual(row.backgroundImageUrl, null, 'explicit empty array must clear the derived url');
    // logo untouched — only the sent array is recomputed.
    assert.strictEqual(row.logoUrl, 'https://cdn/logo-original.png');
  });

  it('persists the guardSettings JSON blob onto the tenant settings row', async () => {
    const db = seedSettings();
    const gs = { inactivityAlert: true, inactivityThresholdMin: 45, shiftRemindersEnabled: false, licenseExpiryAlert: true, licenseExpiryDays: 15 };
    await SettingsRepository.save({ guardSettings: gs }, { ...repoOptions(db, TENANT), transaction: undefined });
    assert.deepStrictEqual(db.settings.rows[0].guardSettings, gs);
  });
});

// ═══════════════════ settingsSave handler (gate + sanitize) ══════════════════
describe('op-settings · settingsSave handler', () => {
  beforeEach(() => {
    sinon.stub(AuditLogRepository, 'log').resolves();
    sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
    sinon.stub(FileRepository, 'fillDownloadUrl').resolves([] as any);
  });
  afterEach(() => sinon.restore());

  it('denies a non-admin (securityGuard) with 403 and writes nothing', async () => {
    const db = buildDb({ settings: [{ id: TENANT, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, TENANT, {
      currentUser: userWithRoles(['securityGuard'], TENANT),
      body: { settings: { postRules: { geofenceExitAlert: true } } },
    });
    const res = fakeRes();
    await settingsSave(req, res, () => {});
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    // No row mutated.
    assert.strictEqual((db.settings.rows[0].__updateCalls || []).length, 0);
  });

  it('an admin sanitizes postRules to boolean-only before persisting (strips garbage)', async () => {
    const db = buildDb({ settings: [{ id: TENANT, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, TENANT, {
      currentUser: adminUser(TENANT),
      body: { settings: { postRules: { geofenceExitAlert: 'truthy', evil: 'x' } } },
    });
    const res = fakeRes();
    await settingsSave(req, res, () => {});
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const stored = db.settings.rows[0].postRules;
    assert.strictEqual(stored.geofenceExitAlert, true);
    assert.strictEqual(stored.requireActiveShiftForRounds, false);
    assert.ok(!('evil' in stored), 'unknown key must be sanitized out');
  });

  it('an admin clamps guardSettings thresholds before persisting', async () => {
    const db = buildDb({ settings: [{ id: TENANT, tenantId: TENANT, deletedAt: null }] });
    const req = fakeReq(db, TENANT, {
      currentUser: adminUser(TENANT),
      body: { settings: { guardSettings: { inactivityThresholdMin: 5, licenseExpiryDays: 9999 } } },
    });
    const res = fakeRes();
    await settingsSave(req, res, () => {});
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const gs = db.settings.rows[0].guardSettings;
    assert.strictEqual(gs.inactivityThresholdMin, 10);
    assert.strictEqual(gs.licenseExpiryDays, 120);
  });
});

// ═══════════════════ rondaSettings GET/PUT handlers ══════════════════════════
describe('op-settings · rondaSettings routes', () => {
  // The routes register onto an express-like app; capture the handlers.
  function mountRoutes() {
    const handlers: Record<string, any> = {};
    const app = {
      get: (path: string, h: any) => (handlers[`GET ${path}`] = h),
      put: (path: string, h: any) => (handlers[`PUT ${path}`] = h),
    };
    rondaSettingsRoutes(app);
    return handlers;
  }
  const GET = '/tenant/:tenantId/ronda-settings';
  const PUT = '/tenant/:tenantId/ronda-settings';

  it('GET returns tenant defaults (isDefault=true) when nothing is stored', async () => {
    const db = buildDb();
    const req = fakeReq(db, TENANT, { query: {} });
    const res = fakeRes();
    await mountRoutes()[`GET ${GET}`](req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.frequencyMinutes, 60);
    assert.strictEqual(res.body.isDefault, true);
    assert.strictEqual(res.body.id, null);
  });

  it('GET prefers the per-post override over the tenant default', async () => {
    const db = buildDb({
      rondaSettings: [
        { id: 'rs-def', tenantId: TENANT, postSiteId: null, frequencyMinutes: 60, deletedAt: null },
        { id: 'rs-post', tenantId: TENANT, postSiteId: 'ps-1', frequencyMinutes: 15, deletedAt: null },
      ],
    });
    const req = fakeReq(db, TENANT, { query: { postSiteId: 'ps-1' } });
    const res = fakeRes();
    await mountRoutes()[`GET ${GET}`](req, res);
    assert.strictEqual(res.body.frequencyMinutes, 15, 'must return the per-post override');
    assert.strictEqual(res.body.isDefault, false);
    assert.strictEqual(res.body.id, 'rs-post');
  });

  it('GET is denied for a role without postSiteRead → 403', async () => {
    const db = buildDb();
    // securityGuard actually HOLDS postSiteRead (ALL_STAFF_ROLES); use a role that does not.
    const req = fakeReq(db, TENANT, { currentUser: userWithRoles(['custom'], TENANT), query: {} });
    const res = fakeRes();
    await mountRoutes()[`GET ${GET}`](req, res);
    assert.strictEqual(res.statusCode, 403);
  });

  it('PUT creates a new override merged over DEFAULTS (unsent keys keep defaults)', async () => {
    const db = buildDb();
    const req = fakeReq(db, TENANT, {
      body: { data: { postSiteId: 'ps-1', frequencyMinutes: 30, requirePhoto: false } },
    });
    const res = fakeRes();
    await mountRoutes()[`PUT ${PUT}`](req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const written = db.rondaSettings.calls.create[0];
    assert.strictEqual(written.frequencyMinutes, 30, 'sent value applied');
    assert.strictEqual(written.requirePhoto, false, 'sent value applied');
    assert.strictEqual(written.graceMinutes, 10, 'unsent key keeps the default');
    assert.strictEqual(written.requireGeofence, true, 'unsent key keeps the default');
    assert.strictEqual(written.postSiteId, 'ps-1');
    assert.strictEqual(written.tenantId, TENANT);
    assert.strictEqual(written.createdById, USER_ID);
  });

  it('PUT on an existing record applies ONLY the sent keys (no clobber of others)', async () => {
    const db = buildDb({
      rondaSettings: [
        { id: 'rs-1', tenantId: TENANT, postSiteId: null, frequencyMinutes: 60, graceMinutes: 5, geofenceRadius: 80, requireNote: true, deletedAt: null },
      ],
    });
    const req = fakeReq(db, TENANT, { body: { data: { frequencyMinutes: 20 } } });
    const res = fakeRes();
    await mountRoutes()[`PUT ${PUT}`](req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const row = db.rondaSettings.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.frequencyMinutes, 20);
    assert.ok(!('graceMinutes' in patch), 'unsent graceMinutes must not be in the patch');
    assert.strictEqual(row.graceMinutes, 5, 'graceMinutes preserved');
    assert.strictEqual(row.geofenceRadius, 80, 'geofenceRadius preserved');
    assert.strictEqual(row.requireNote, true, 'requireNote preserved');
  });

  it('PUT is denied without postSiteEdit → 403 (nothing written)', async () => {
    const db = buildDb();
    const req = fakeReq(db, TENANT, {
      currentUser: userWithRoles(['securityGuard'], TENANT),
      body: { data: { frequencyMinutes: 5 } },
    });
    const res = fakeRes();
    await mountRoutes()[`PUT ${PUT}`](req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(db.rondaSettings.calls.create.length, 0);
  });
});
