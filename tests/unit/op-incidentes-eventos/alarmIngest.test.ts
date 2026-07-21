/**
 * Alarm ingest pipeline — the central-station heart (services/alarm/normalizer).
 *
 * ingestSignal is the single code path that HTTP webhook/manual handlers AND the
 * raw socket receiver all funnel through. This suite exercises it end-to-end
 * against the fake db and pins the business invariants an operator relies on:
 *
 *   - panel resolution by id / accountNumber, ALWAYS tenant-scoped (isolation)
 *   - the immutable alarmSignal is persisted even when nothing correlates
 *   - event-code → {category, priority} mapping (SIA + Contact ID + panic)
 *   - a fresh signal OPENS a case (right priority/category/title/FKs/source)
 *   - the alarmEvent is linked to that case; an audit row is written
 *   - the operator console is notified (platform_events fan-out) on a new case
 *   - grouping window: a later signal JOINS the open case (no second case)
 *   - priority escalation: a more-severe event raises the case priority
 *   - restore/test/openclose/supervisory do NOT open a case on their own
 *   - runaway suppression: an identical repeat inside 60 s collapses (no dup)
 *   - the panel's lastSignalAt / status is always touched
 *
 * Hooks are describe-scoped per the suite convention.
 */
import assert from 'assert';
import { ingestSignal } from '../../../src/services/alarm/normalizer';
import ingestManual from '../../../src/api/alarm/ingestManual';
import { buildDb, fakeReq, fakeRes, TENANT, OTHER_TENANT } from './helpers';

function seedPanel(extra: any = {}) {
  return {
    id: 'pnl-1',
    tenantId: TENANT,
    name: 'Panel Bodega Norte',
    accountNumber: 'ACCT-042',
    postSiteId: 'ps-1',
    stationId: 'st-1',
    customerId: 'ca-1',
    status: 'unknown',
    priority: 3,
    deletedAt: null,
    ...extra,
  };
}

function platformEventInserts(db: any) {
  return db.__queries.filter((q: any) => /platform_events/i.test(q.sql));
}

describe('op-incidentes · alarm ingest — signal persistence & panel resolution', () => {
  it('persists the immutable signal and resolves the panel by id (tenant-scoped)', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA',
      zoneNumber: '001',
      channel: 'ip',
      raw: 'RAW-BA-001',
    });

    assert.strictEqual(db.alarmSignal.calls.create.length, 1, 'signal not persisted');
    const sig = db.alarmSignal.calls.create[0];
    assert.strictEqual(sig.alarmPanelId, 'pnl-1');
    assert.strictEqual(sig.accountNumber, 'ACCT-042', 'accountNumber not backfilled from panel');
    assert.strictEqual(sig.eventCode, 'BA');
    assert.strictEqual(sig.raw, 'RAW-BA-001');
    assert.strictEqual(sig.tenantId, TENANT);
    assert.ok(res.case, 'a burglary alarm must open a case');
  });

  it('resolves the panel by accountNumber when no id is given', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const res = await ingestSignal(db, TENANT, {
      accountNumber: 'ACCT-042',
      format: 'contactid',
      eventCode: '130',
      zoneNumber: '005',
    });
    assert.ok(res.case, 'account-number resolution must still open a case');
    assert.strictEqual(res.case.alarmPanelId, 'pnl-1');
  });

  it('records the signal but opens NO case when the panel cannot be resolved', async () => {
    const db = buildDb();
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'ghost',
      format: 'sia',
      eventCode: 'BA',
    });
    assert.strictEqual(db.alarmSignal.calls.create.length, 1, 'signal must still be recorded');
    assert.strictEqual(res.case, null);
    assert.strictEqual(res.event, null);
    assert.strictEqual(db.alarmCase.calls.create.length, 0);
  });

  it('ISOLATION: a panel id from another tenant does not resolve → no case here', async () => {
    const db = buildDb({ alarmPanels: [seedPanel({ tenantId: OTHER_TENANT })] });
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA',
    });
    assert.strictEqual(res.case, null, 'must not correlate against a foreign-tenant panel');
    assert.strictEqual(db.alarmCase.calls.create.length, 0);
    // The signal is still recorded under THIS tenant for audit.
    assert.strictEqual(db.alarmSignal.calls.create[0].tenantId, TENANT);
  });
});

describe('op-incidentes · alarm ingest — case creation, event link & fan-out', () => {
  it('opens a case with the mapped category/priority, panel FKs and source', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'FA', // Fire alarm → category fire, priority 1
      zoneNumber: '003',
    });

    const c = db.alarmCase.calls.create[0];
    assert.ok(c, 'no case created');
    assert.strictEqual(c.status, 'queued');
    assert.strictEqual(c.category, 'fire');
    assert.strictEqual(c.priority, 1, 'fire alarm must be priority 1');
    assert.strictEqual(c.source, 'alarm_panel');
    assert.strictEqual(c.postSiteId, 'ps-1', 'case must inherit panel post-site');
    assert.strictEqual(c.stationId, 'st-1');
    assert.strictEqual(c.customerId, 'ca-1');
    assert.strictEqual(c.tenantId, TENANT);
    assert.ok(String(c.title).includes('Fire alarm'), 'case title should describe the event');
  });

  it('links the alarmEvent to the case and writes a case.opened audit row', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'contactid',
      eventCode: '130', // Burglary → priority 2
      zoneNumber: '004',
    });

    const ev = db.alarmEvent.calls.create[0];
    assert.ok(ev, 'no alarmEvent created');
    assert.strictEqual(ev.category, 'burglary');
    assert.strictEqual(ev.priority, 2);
    assert.strictEqual(ev.alarmCaseId, res.case.id, 'event not linked to the case');
    assert.strictEqual(ev.alarmSignalId, res.signal.id, 'event not linked to the signal');
    assert.strictEqual(ev.zoneNumber, '004');

    const opened = db.alarmAuditLog.calls.create.find((a: any) => a.action === 'case.opened');
    assert.ok(opened, 'no case.opened audit row');
    assert.strictEqual(opened.alarmCaseId, res.case.id);
    assert.strictEqual(opened.tenantId, TENANT);
  });

  it('notifies the operator console (platform_events) targeting the monitoring roles', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA',
      zoneNumber: '001',
    });

    const inserts = platformEventInserts(db);
    assert.strictEqual(inserts.length, 1, 'exactly one operator notification expected');
    const repl = inserts[0].opts.replacements;
    // [id, tenantId, eventType, title, body, payload, recipientUserId, targetRoles, ...]
    assert.strictEqual(repl[1], TENANT);
    assert.strictEqual(repl[2], 'alarm.case.new', 'new case must emit alarm.case.new');
    assert.ok(String(repl[7]).includes('securitySupervisor'), 'must target operator roles');
    assert.ok(String(repl[7]).includes('dispatcher'));
  });

  it('touches the panel: lastSignalAt is stamped on any traffic', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    await ingestSignal(db, TENANT, { alarmPanelId: 'pnl-1', format: 'sia', eventCode: 'BA' });
    const panel = db.alarmPanel.rows[0];
    assert.ok(panel.lastSignalAt instanceof Date, 'lastSignalAt not stamped');
  });
});

describe('op-incidentes · alarm ingest — manual (operator-phoned) passthrough', () => {
  it('honors an operator-supplied category/priority/description verbatim', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'manual',
      channel: 'manual',
      category: 'holdup',
      priority: 1,
      description: 'Robo en progreso reportado por teléfono',
    });
    assert.strictEqual(res.case.category, 'holdup', 'manual category must pass through');
    assert.strictEqual(res.case.priority, 1, 'manual priority must pass through');
    const ev = db.alarmEvent.calls.create[0];
    assert.strictEqual(ev.description, 'Robo en progreso reportado por teléfono');
  });
});

describe('op-incidentes · alarm ingest — manual priority coercion (BUG, XFAIL)', () => {
  // BUG: api/alarm/ingestManual passes `priority: body.priority` straight into
  // the normalizer, which only honors it when `typeof priority === 'number'`
  // (normalizer.ts:154 / :160) and otherwise falls back to 3 (medium). A manual
  // (operator phoned-in) alarm whose form serializes priority as a STRING — e.g.
  // a <select> value "1" — is therefore SILENTLY DOWNGRADED from critical (1) to
  // medium (3), demoting a hold-up in the operator queue and its dispatch urgency.
  // CORRECT behavior: ingestManual should coerce a numeric string to a number
  // (Number(body.priority)) before ingest, so "1" lands as priority 1.
  //
  // This test PINS the current (buggy) behavior. Flip the assertion to `1` once
  // ingestManual coerces the value.
  it('FIXED: a string priority "1" (del <select>) se mantiene crítica (1), no degrada a 3', async () => {
    const db = buildDb({
      alarmPanels: [{ id: 'pnl-1', tenantId: TENANT, name: 'Panel', accountNumber: 'A1', deletedAt: null }],
    });
    const req = fakeReq(db, {
      params: { tenantId: TENANT },
      body: { data: { alarmPanelId: 'pnl-1', category: 'holdup', priority: '1', description: 'Atraco en curso' } },
    });
    const res = fakeRes();
    await ingestManual(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const c = db.alarmCase.rows[0];
    assert.ok(c, 'case should have been opened');
    // ingestManual ahora coacciona Number(priority) antes del ingest → 1 (crítica).
    assert.strictEqual(c.priority, 1, 'el atraco conserva su urgencia crítica');
  });
});

describe('op-incidentes · alarm ingest — grouping window & escalation', () => {
  it('a second (different-code) signal JOINS the open case — no duplicate case', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const first = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA', // burglary p2, zone 001
      zoneNumber: '001',
    });
    const second = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'GA', // fire p1, zone 002 (different code+zone → not runaway)
      zoneNumber: '002',
    });

    assert.strictEqual(db.alarmCase.calls.create.length, 1, 'a second case was wrongly opened');
    assert.strictEqual(second.case.id, first.case.id, 'signals in the window must share a case');
    assert.strictEqual(db.alarmEvent.calls.create.length, 2, 'both events must be recorded');
    const appended = db.alarmAuditLog.calls.create.find((a: any) => a.action === 'event.appended');
    assert.ok(appended, 'second signal must append an audit entry to the case');
  });

  it('escalates the case priority when a later event is more severe', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'contactid',
      eventCode: '130', // burglary p2
      zoneNumber: '001',
    });
    const before = db.alarmCase.rows[0].priority;
    assert.strictEqual(before, 2);

    await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'contactid',
      eventCode: '110', // fire p1 — more severe
      zoneNumber: '002',
    });
    assert.strictEqual(db.alarmCase.rows[0].priority, 1, 'case must escalate to the higher priority');
  });
});

describe('op-incidentes · alarm ingest — non-case categories & runaway suppression', () => {
  it('a lone restore records the event but opens NO case', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const res = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BR', // burglary restore → category restore
      zoneNumber: '001',
    });
    assert.strictEqual(db.alarmCase.calls.create.length, 0, 'a restore must not open a case');
    assert.strictEqual(res.case, null);
    const ev = db.alarmEvent.calls.create[0];
    assert.ok(ev, 'the event must still be recorded for history');
    assert.strictEqual(ev.alarmCaseId, null);
    // No operator fan-out without a case.
    assert.strictEqual(platformEventInserts(db).length, 0);
  });

  it('a restore flips the panel status to online', async () => {
    const db = buildDb({ alarmPanels: [seedPanel({ status: 'alarm' })] });
    await ingestSignal(db, TENANT, { alarmPanelId: 'pnl-1', format: 'sia', eventCode: 'BR' });
    assert.strictEqual(db.alarmPanel.rows[0].status, 'online');
  });

  it('a lone test/openclose signal opens no case', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    await ingestSignal(db, TENANT, { alarmPanelId: 'pnl-1', format: 'sia', eventCode: 'RP' }); // test
    await ingestSignal(db, TENANT, { alarmPanelId: 'pnl-1', format: 'sia', eventCode: 'OP' }); // openclose
    assert.strictEqual(db.alarmCase.calls.create.length, 0);
  });

  it('runaway: an identical repeat inside 60 s collapses (no dup case/event)', async () => {
    const db = buildDb({ alarmPanels: [seedPanel()] });
    const t0 = new Date('2026-07-19T10:00:00Z');
    const first = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA',
      zoneNumber: '001',
      receivedAt: t0,
    });
    const second = await ingestSignal(db, TENANT, {
      alarmPanelId: 'pnl-1',
      format: 'sia',
      eventCode: 'BA',
      zoneNumber: '001',
      receivedAt: new Date(t0.getTime() + 10_000), // +10 s
    });

    assert.strictEqual(second.suppressed, true, 'the repeat must be suppressed');
    assert.strictEqual(second.event, null, 'no duplicate event on a suppressed repeat');
    assert.strictEqual(db.alarmCase.calls.create.length, 1, 'only one case');
    assert.strictEqual(db.alarmEvent.calls.create.length, 1, 'only one event');
    // The runaway is still auditable on the open case.
    const runaway = db.alarmAuditLog.calls.create.find(
      (a: any) => a.action === 'signal.runaway_suppressed',
    );
    assert.ok(runaway, 'runaway must leave an audit note');
    assert.strictEqual(runaway.alarmCaseId, first.case.id);
    // Both raw signals are still persisted (nothing is silently dropped).
    assert.strictEqual(db.alarmSignal.calls.create.length, 2);
  });
});
