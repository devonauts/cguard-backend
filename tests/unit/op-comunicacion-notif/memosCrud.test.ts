/**
 * Unit tests — memos CRUD persistence fidelity + the recipient-link null-clobber
 * guard. Memos are per-employee (addressed to one securityGuard) and reads are
 * recipient-scoped, so silently nulling guardNameId on a partial edit makes the
 * memo VANISH from the addressed guard's app. This suite pins:
 *   - MemosRepository.create/update  (whitelist fidelity, guardName→guardNameId
 *                                     alias, tenant + audit ids, 404 scope,
 *                                     error propagation)
 *   - the repo-level partial-update presence guard (guardNameId preserved)
 *   - MemosService.update            (the service-level guard: filterIdInTenant
 *                                     only runs when guardName is sent)
 *   - MemosService.update foreign-guard reassign filtered to null
 *
 * REAL production repository/service against a Sequelize-shaped fake db.
 */
import assert from 'assert';
import sinon from 'sinon';

import MemosRepository from '../../../src/database/repositories/memosRepository';
import MemosService from '../../../src/services/memosService';
import AuditLogRepository from '../../../src/database/repositories/auditLogRepository';
import FileRepository from '../../../src/database/repositories/fileRepository';
import Error404 from '../../../src/errors/Error404';
import {
  buildDb, options, adminUser, TENANT, OTHER_TENANT, ADMIN_USER_ID, SG_A, SG_B,
} from './helpers';

function stubSideChannels() {
  if ((AuditLogRepository as any).log?.restore) (AuditLogRepository as any).log.restore();
  sinon.stub(AuditLogRepository, 'log').resolves();
  if ((FileRepository as any).replaceRelationFiles?.restore) (FileRepository as any).replaceRelationFiles.restore();
  sinon.stub(FileRepository, 'replaceRelationFiles').resolves();
  if ((FileRepository as any).fillDownloadUrl?.restore) (FileRepository as any).fillDownloadUrl.restore();
  sinon.stub(FileRepository, 'fillDownloadUrl').resolves(null as any);
}

describe('op-comunicacion-notif · MemosRepository.create', () => {
  beforeEach(stubSideChannels);
  afterEach(() => sinon.restore());

  const FULL = {
    dateTime: '2026-07-19T10:00:00Z',
    subject: 'Cambio de consigna',
    content: 'A partir de hoy, ronda cada 2 horas en el perímetro norte.',
    wasAccepted: false,
    type: 'operational',
    guardRatingId: null,
    importHash: 'memo-hash-1',
  };

  it('persists every whitelisted field + maps guardName→guardNameId with tenant/audit ids', async () => {
    const db = buildDb();
    await MemosRepository.create({ ...FULL, guardName: SG_A }, options(db, adminUser()));

    assert.strictEqual(db.memos.calls.create.length, 1);
    const w = db.memos.calls.create[0];
    for (const [k, v] of Object.entries(FULL)) {
      assert.deepStrictEqual(w[k], v, `field "${k}" dropped or altered on create`);
    }
    assert.strictEqual(w.guardNameId, SG_A, 'guardName not mapped to guardNameId');
    assert.strictEqual(w.tenantId, TENANT);
    assert.strictEqual(w.createdById, ADMIN_USER_ID);
    assert.strictEqual(w.updatedById, ADMIN_USER_ID);
  });

  it('writes memoDocumentPdf through the file relation, not as a column', async () => {
    const db = buildDb();
    const pdfs = [{ id: 'f-1', name: 'memo.pdf' }];
    await MemosRepository.create({ ...FULL, guardName: SG_A, memoDocumentPdf: pdfs }, options(db, adminUser()));
    const stub = FileRepository.replaceRelationFiles as sinon.SinonStub;
    const call = stub.getCalls().find((c) => c.args[0].belongsToColumn === 'memoDocumentPdf');
    assert.ok(call, 'memoDocumentPdf relation not written');
    assert.deepStrictEqual(call!.args[1], pdfs);
    // And it never leaks in as a scalar column.
    assert.ok(!('memoDocumentPdf' in db.memos.calls.create[0]), 'memoDocumentPdf must not be a column');
  });

  it('an unassigned memo stores guardNameId = null (guardName omitted)', async () => {
    const db = buildDb();
    await MemosRepository.create({ ...FULL }, options(db, adminUser()));
    assert.strictEqual(db.memos.calls.create[0].guardNameId, null);
  });

  it('a db failure on create PROPAGATES (not swallowed into a fake success)', async () => {
    const db = buildDb();
    db.memos.create = async () => {
      throw new Error('memo insert failed');
    };
    await assert.rejects(
      () => MemosRepository.create({ ...FULL, guardName: SG_A }, options(db, adminUser())),
      /memo insert failed/,
    );
  });
});

describe('op-comunicacion-notif · MemosRepository.update (scope + partial-update guard)', () => {
  beforeEach(stubSideChannels);
  afterEach(() => sinon.restore());

  const existing = () => ({
    id: 'memo-1',
    tenantId: TENANT,
    dateTime: '2026-07-01T08:00:00Z',
    subject: 'Viejo asunto',
    content: 'Viejo contenido',
    wasAccepted: false,
    guardNameId: SG_A,
    deletedAt: null,
  });

  it('applies the patch onto the right row (id + tenantId in the where) and remaps guardName', async () => {
    const db = buildDb({ memos: [existing()] });
    await MemosRepository.update(
      'memo-1',
      { subject: 'Nuevo asunto', content: 'Nuevo contenido', wasAccepted: true, guardName: SG_B },
      options(db, adminUser()),
    );
    const find = db.memos.calls.findOne[0];
    assert.strictEqual(find.where.id, 'memo-1');
    assert.strictEqual(find.where.tenantId, TENANT);

    const row = db.memos.rows[0];
    const patch = row.__updateCalls[0];
    assert.strictEqual(patch.subject, 'Nuevo asunto');
    assert.strictEqual(patch.content, 'Nuevo contenido');
    assert.strictEqual(patch.wasAccepted, true);
    assert.strictEqual(patch.guardNameId, SG_B, 'guardName not remapped to guardNameId on update');
    assert.strictEqual(patch.updatedById, ADMIN_USER_ID);
    assert.strictEqual(row.subject, 'Nuevo asunto');
  });

  it('a partial patch that omits guardName KEEPS guardNameId (repo presence guard)', async () => {
    const db = buildDb({ memos: [existing()] });
    await MemosRepository.update('memo-1', { subject: 'Solo el asunto' }, options(db, adminUser()));
    const row = db.memos.rows[0];
    assert.strictEqual(row.subject, 'Solo el asunto');
    assert.strictEqual(row.guardNameId, SG_A, 'guardNameId wiped by a partial update (memo would vanish from the guard app)');
  });

  it('an explicit guardName:null DOES unassign (legacy explicit-clear kept)', async () => {
    const db = buildDb({ memos: [existing()] });
    await MemosRepository.update('memo-1', { guardName: null }, options(db, adminUser()));
    assert.strictEqual(db.memos.rows[0].guardNameId, null);
  });

  it('refuses to update another tenant\'s memo (404, nothing written)', async () => {
    const db = buildDb({ memos: [{ ...existing(), tenantId: OTHER_TENANT }] });
    await assert.rejects(
      () => MemosRepository.update('memo-1', { subject: 'Hack' }, options(db, adminUser())),
      (e: any) => e instanceof Error404,
    );
    assert.strictEqual(db.memos.rows[0].__updateCalls.length, 0);
  });

  it('a db failure on row.update PROPAGATES', async () => {
    const db = buildDb({ memos: [existing()] });
    db.memos.rows[0].update = async () => {
      throw new Error('memo write failed');
    };
    await assert.rejects(
      () => MemosRepository.update('memo-1', { subject: 'X' }, options(db, adminUser())),
      /memo write failed/,
    );
  });
});

describe('op-comunicacion-notif · MemosService.update (service-level recipient guard)', () => {
  beforeEach(stubSideChannels);
  afterEach(() => sinon.restore());

  const seed = () => ({
    memos: [
      {
        id: 'memo-1',
        tenantId: TENANT,
        subject: 'Asunto',
        content: 'Contenido',
        wasAccepted: false,
        guardNameId: SG_A,
        deletedAt: null,
      },
    ],
    securityGuards: [
      { id: SG_A, tenantId: TENANT, guardId: 'u-a', fullName: 'Guardia A', deletedAt: null },
    ],
  });

  it('editing only the subject does NOT detach the memo from its guard (guardNameId preserved)', async () => {
    const db = buildDb(seed());
    const svc = new MemosService(options(db, adminUser()));
    await svc.update('memo-1', { subject: 'Asunto corregido' });
    const row = db.memos.rows[0];
    assert.strictEqual(row.subject, 'Asunto corregido');
    assert.strictEqual(row.guardNameId, SG_A, 'partial edit through the service nulled guardNameId');
    // The tenant filter must NOT have run (guardName was never sent).
    assert.strictEqual(db.securityGuard.calls.findAll.length, 0, 'filterIdInTenant ran on a patch that never sent guardName');
  });

  it('reassigning to a valid tenant guard persists the new guardNameId', async () => {
    const s = seed();
    s.securityGuards.push({ id: SG_B, tenantId: TENANT, guardId: 'u-b', fullName: 'Guardia B', deletedAt: null });
    const db = buildDb(s);
    const svc = new MemosService(options(db, adminUser()));
    await svc.update('memo-1', { guardName: SG_B });
    assert.strictEqual(db.memos.rows[0].guardNameId, SG_B);
  });

  it('reassigning to a FOREIGN-tenant guard filters the id to null (not persisted)', async () => {
    const s = seed();
    // sg-x belongs to OTHER_TENANT — filterIdInTenant must reject it.
    s.securityGuards.push({ id: SG_B, tenantId: OTHER_TENANT, guardId: 'u-x', fullName: 'Ajeno', deletedAt: null });
    const db = buildDb(s);
    const svc = new MemosService(options(db, adminUser()));
    await svc.update('memo-1', { guardName: SG_B });
    assert.strictEqual(db.memos.rows[0].guardNameId, null, "another tenant's guard id must not persist");
  });
});
