/**
 * Schedule Proposal Service (draft spine — Phase 1)
 *
 * Generation NEVER writes to the live `shift` table. Instead it computes the
 * would-be horario, diffs it against the live schedule, and stores a draft
 * `scheduleProposal` + `proposedShift` rows. An admin reviews the diff and then
 * PUBLISHES (applied atomically) or DISCARDS. Live shifts only change on publish,
 * and only after explicit confirmation — req 4 (draft) + req 8 (confirm-overwrite).
 */
import { computeShiftsForAssignment, ComputedShift } from './shiftGenerationService';

type Scope = 'station' | 'postSite' | 'tenant';

interface GenerateInput {
  scope: Scope;
  stationId?: string | null;
  postSiteId?: string | null;
  title?: string | null;
}

const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);
const sameInstant = (a: any, b: any) => new Date(a).getTime() === new Date(b).getTime();

/** Resolve the active rotation/adhoc assignments covered by the scope. */
async function assignmentsForScope(db: any, tenantId: string, input: GenerateInput): Promise<any[]> {
  const { Op } = db.Sequelize;
  const where: any = { tenantId, status: 'active', deletedAt: null };
  if (input.scope === 'station') {
    if (!input.stationId) return [];
    where.stationId = input.stationId;
  } else if (input.scope === 'postSite') {
    if (!input.postSiteId) return [];
    const stations = await db.station.findAll({
      where: { tenantId, postSiteId: input.postSiteId, deletedAt: null },
      attributes: ['id'],
    });
    const ids = stations.map((s: any) => s.id);
    if (!ids.length) return [];
    where.stationId = { [Op.in]: ids };
  }
  return db.guardAssignment.findAll({ where });
}

/**
 * Generate a DRAFT proposal: compute the would-be shifts for every assignment in
 * scope, diff against the live future shifts, and persist the staged changes.
 */
export async function generateProposal(
  db: any,
  tenantId: string,
  userId: string,
  input: GenerateInput,
) {
  const { Op } = db.Sequelize;
  const assignments = await assignmentsForScope(db, tenantId, input);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const proposalRows: any[] = [];
  let added = 0, removed = 0, changed = 0, kept = 0;
  const guardsAffected = new Set<string>();
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;

  for (const a of assignments) {
    const assignment = a.get ? a.get({ plain: true }) : a;
    const computed: ComputedShift[] = await computeShiftsForAssignment(db, assignment, tenantId);

    // Live future shifts for this assignment.
    const liveShifts = await db.shift.findAll({
      where: { guardAssignmentId: assignment.id, tenantId, startTime: { [Op.gte]: today } },
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'postSiteId', 'startTime', 'endTime'],
    });

    const proposedByDay = new Map<string, ComputedShift>();
    for (const c of computed) {
      proposedByDay.set(dayKey(c.startTime), c);
      if (!windowStart || c.startTime < windowStart) windowStart = c.startTime;
      if (!windowEnd || c.endTime > windowEnd) windowEnd = c.endTime;
    }
    const liveByDay = new Map<string, any>();
    for (const l of liveShifts) liveByDay.set(dayKey(l.startTime), l);

    const days = new Set<string>([...proposedByDay.keys(), ...liveByDay.keys()]);
    for (const day of days) {
      const p = proposedByDay.get(day);
      const l = liveByDay.get(day);
      const base = {
        tenantId,
        proposalId: null as any, // filled after the proposal row is created
        guardId: (p || l).guardId,
        stationId: (p || l).stationId,
        positionId: (p && p.positionId) ?? (l && l.positionId) ?? null,
        guardAssignmentId: assignment.id,
        postSiteId: (p && p.postSiteId) ?? (l && l.postSiteId) ?? null,
      };
      if (p && l) {
        if (sameInstant(p.startTime, l.startTime) && sameInstant(p.endTime, l.endTime)) {
          kept++;
          proposalRows.push({ ...base, action: 'keep', startTime: p.startTime, endTime: p.endTime, targetShiftId: l.id, meta: { shiftType: p.shiftType } });
        } else {
          changed++;
          guardsAffected.add(base.guardId);
          proposalRows.push({
            ...base, action: 'change', startTime: p.startTime, endTime: p.endTime, targetShiftId: l.id,
            meta: { shiftType: p.shiftType, prev: { startTime: l.startTime, endTime: l.endTime } },
          });
        }
      } else if (p && !l) {
        added++;
        guardsAffected.add(base.guardId);
        proposalRows.push({ ...base, action: 'add', startTime: p.startTime, endTime: p.endTime, targetShiftId: null, meta: { shiftType: p.shiftType } });
      } else if (l && !p) {
        removed++;
        guardsAffected.add(base.guardId);
        proposalRows.push({ ...base, action: 'remove', startTime: l.startTime, endTime: l.endTime, targetShiftId: l.id, meta: {} });
      }
    }
  }

  const summary = {
    added, removed, changed, kept,
    total: added + removed + changed + kept,
    guardsAffected: guardsAffected.size,
    assignments: assignments.length,
  };

  const proposal = await db.scheduleProposal.create({
    tenantId,
    title: input.title || null,
    scope: input.scope,
    stationId: input.stationId || null,
    postSiteId: input.postSiteId || null,
    status: 'draft',
    windowStart,
    windowEnd,
    params: { scope: input.scope, stationId: input.stationId || null, postSiteId: input.postSiteId || null },
    summary,
    generatedById: userId,
  });

  if (proposalRows.length) {
    proposalRows.forEach((r) => { r.proposalId = proposal.id; });
    // Persist non-keep rows always; persist a capped sample of "keep" rows just
    // so the preview can show unchanged context without bloating the table.
    const changes = proposalRows.filter((r) => r.action !== 'keep');
    const keeps = proposalRows.filter((r) => r.action === 'keep').slice(0, 200);
    await db.proposedShift.bulkCreate([...changes, ...keeps]);
  }

  return { proposalId: proposal.id, summary };
}

/** Load a proposal with its staged changes (changes first, keeps capped). */
export async function getProposal(db: any, tenantId: string, proposalId: string) {
  const proposal = await db.scheduleProposal.findOne({ where: { id: proposalId, tenantId } });
  if (!proposal) return null;
  const { Op } = db.Sequelize;
  const changes = await db.proposedShift.findAll({
    where: { proposalId, tenantId, action: { [Op.ne]: 'keep' } },
    order: [['startTime', 'ASC']],
    limit: 1000,
  });
  return { proposal: proposal.get({ plain: true }), changes: changes.map((c: any) => c.get({ plain: true })) };
}

/**
 * Publish a draft proposal: apply its staged changes to the LIVE shift table in
 * one transaction. Caller must already have confirmed.
 */
export async function publishProposal(db: any, tenantId: string, userId: string, proposalId: string) {
  const { Op } = db.Sequelize;
  const proposal = await db.scheduleProposal.findOne({ where: { id: proposalId, tenantId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'draft') throw new Error(`Proposal is ${proposal.status}, cannot publish`);

  const rows = await db.proposedShift.findAll({
    where: { proposalId, tenantId, action: { [Op.ne]: 'keep' } },
  });

  const transaction = await db.sequelize.transaction();
  try {
    for (const r of rows) {
      if (r.action === 'remove' && r.targetShiftId) {
        await db.shift.destroy({ where: { id: r.targetShiftId, tenantId }, force: true, transaction });
      } else if (r.action === 'change' && r.targetShiftId) {
        await db.shift.update(
          { guardId: r.guardId, positionId: r.positionId, startTime: r.startTime, endTime: r.endTime, updatedById: userId },
          { where: { id: r.targetShiftId, tenantId }, transaction },
        );
      } else if (r.action === 'add') {
        await db.shift.create(
          {
            guardId: r.guardId,
            stationId: r.stationId,
            positionId: r.positionId,
            guardAssignmentId: r.guardAssignmentId,
            postSiteId: r.postSiteId,
            startTime: r.startTime,
            endTime: r.endTime,
            tenantId,
            createdById: userId,
            updatedById: userId,
          },
          { transaction },
        );
      }
    }
    await proposal.update(
      { status: 'published', publishedAt: new Date(), approvedById: userId },
      { transaction },
    );
    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }

  return { published: true, summary: proposal.summary };
}

/** Discard a draft proposal (no effect on live shifts). */
export async function discardProposal(db: any, tenantId: string, userId: string, proposalId: string) {
  const proposal = await db.scheduleProposal.findOne({ where: { id: proposalId, tenantId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'published') throw new Error('Cannot discard a published proposal');
  await proposal.update({ status: 'discarded' });
  return { discarded: true };
}
