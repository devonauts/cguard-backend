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
import { getCostSettings, computeShiftsCost } from './scheduleCostService';

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

  // Cost is projected over the next 30 days (a monthly figure) for current vs
  // proposed schedules — req 5: make the money impact visible before publish.
  const costEnd = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const liveForCost: any[] = [];
  const proposedForCost: any[] = [];

  for (const a of assignments) {
    const assignment = a.get ? a.get({ plain: true }) : a;
    const computed: ComputedShift[] = await computeShiftsForAssignment(db, assignment, tenantId);

    // Live future shifts for this assignment.
    const liveShifts = await db.shift.findAll({
      where: { guardAssignmentId: assignment.id, tenantId, startTime: { [Op.gte]: today } },
      attributes: ['id', 'guardId', 'stationId', 'positionId', 'postSiteId', 'startTime', 'endTime'],
    });

    for (const c of computed) {
      if (c.startTime <= costEnd) proposedForCost.push({ guardId: c.guardId, startTime: c.startTime, endTime: c.endTime });
    }
    for (const l of liveShifts) {
      if (new Date(l.startTime) <= costEnd) liveForCost.push({ guardId: l.guardId, startTime: l.startTime, endTime: l.endTime });
    }

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

  // Projected monthly cost: current live schedule vs the proposed one.
  let cost: any = null;
  try {
    const costSettings = await getCostSettings(db, tenantId);
    const tenant = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenant && tenant.timezone) || 'UTC';
    const current = computeShiftsCost(liveForCost, costSettings, tz);
    const projected = computeShiftsCost(proposedForCost, costSettings, tz);
    cost = {
      currency: costSettings.currency,
      hasRate: projected.hasRate,
      current: current.totalCost,
      projected: projected.totalCost,
      delta: Math.round((projected.totalCost - current.totalCost) * 100) / 100,
      overtimeHours: projected.overtimeHours,
      nightHours: projected.nightHours,
      windowDays: 30,
    };
  } catch (e: any) {
    console.warn('[scheduleProposal] cost estimate failed:', e?.message || e);
  }

  const summary = {
    added, removed, changed, kept,
    total: added + removed + changed + kept,
    guardsAffected: guardsAffected.size,
    assignments: assignments.length,
    cost,
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
 * one transaction, materialize a per-guard implementation plan, then notify each
 * affected guard (in-app + push + best-effort email). Caller must have confirmed.
 */
export async function publishProposal(db: any, tenantId: string, userId: string, proposalId: string) {
  const { Op } = db.Sequelize;
  const proposal = await db.scheduleProposal.findOne({ where: { id: proposalId, tenantId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'draft') throw new Error(`Proposal is ${proposal.status}, cannot publish`);

  const rows = await db.proposedShift.findAll({
    where: { proposalId, tenantId, action: { [Op.ne]: 'keep' } },
  });

  // Per-guard roll-up for the implementation plan (req 7).
  const byGuard = new Map<string, { added: number; removed: number; changed: number; details: any[] }>();
  for (const r of rows) {
    if (!r.guardId) continue;
    if (!byGuard.has(r.guardId)) byGuard.set(r.guardId, { added: 0, removed: 0, changed: 0, details: [] });
    const g = byGuard.get(r.guardId)!;
    if (r.action === 'add') g.added++;
    else if (r.action === 'remove') g.removed++;
    else if (r.action === 'change') g.changed++;
    if (g.details.length < 10) g.details.push({ action: r.action, startTime: r.startTime, shiftType: r.meta?.shiftType });
  }

  let planId: string | null = null;
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

    const plan = await db.implementationPlan.create(
      { tenantId, proposalId, status: 'pending', totalGuards: byGuard.size, notifiedGuards: 0, publishedById: userId },
      { transaction },
    );
    planId = plan.id;
    if (byGuard.size) {
      const items = Array.from(byGuard.entries()).map(([guardId, g]) => ({
        tenantId, planId: plan.id, guardId,
        added: g.added, removed: g.removed, changed: g.changed,
        details: g.details, notifyStatus: 'pending',
      }));
      await db.implementationPlanItem.bulkCreate(items, { transaction });
    }

    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }

  // Notify AFTER commit — external sends must not hold the transaction open.
  let notified = 0;
  if (planId) {
    try {
      notified = await notifyImplementationPlan(db, tenantId, userId, planId);
    } catch (e: any) {
      console.warn('[scheduleProposal] notify failed:', e?.message || e);
    }
  }

  return { published: true, summary: proposal.summary, plan: { id: planId, totalGuards: byGuard.size, notifiedGuards: notified } };
}

/**
 * Fan out schedule-change notifications to each affected guard: in-app
 * notification row + push (worker-app) + best-effort email. Records per-guard
 * delivery status; never throws. Returns the number of guards reached.
 */
async function notifyImplementationPlan(db: any, tenantId: string, userId: string, planId: string): Promise<number> {
  const items = await db.implementationPlanItem.findAll({ where: { planId, tenantId } });
  if (!items.length) return 0;

  let pushToUser: any = null;
  try { ({ pushToUser } = require('./pushService')); } catch { /* push optional */ }

  let notified = 0;
  for (const item of items) {
    const guardId = item.guardId;
    const parts: string[] = [];
    if (item.added) parts.push(`${item.added} nuevo${item.added === 1 ? '' : 's'}`);
    if (item.changed) parts.push(`${item.changed} modificado${item.changed === 1 ? '' : 's'}`);
    if (item.removed) parts.push(`${item.removed} retirado${item.removed === 1 ? '' : 's'}`);
    const title = 'Tu horario fue actualizado';
    const body = `Cambios en tus turnos: ${parts.join(', ')}. Revisa tu horario en la app.`;
    const channels: any = { push: false, inApp: false, email: false };

    try {
      await db.notification.create({
        title,
        body: body.slice(0, 200),
        targetType: 'User',
        targetId: String(guardId),
        deliveryStatus: 'Pending',
        readStatus: false,
        tenantId,
        whoCreatedTheNotificationId: userId || null,
      });
      channels.inApp = true;
    } catch (e: any) {
      console.warn('[scheduleProposal] in-app notify failed:', e?.message || e);
    }

    if (pushToUser) {
      try {
        const r = await pushToUser(db, tenantId, guardId, { title, body, data: { type: 'schedule_updated' } });
        if (r && r.skipped !== true) channels.push = true;
      } catch { /* push best-effort */ }
    }

    try {
      const guardUser = await db.user.findByPk(guardId, { attributes: ['email'] });
      if (guardUser?.email) {
        const { sendMail } = require('./mailService');
        const html = `<p style="font-size:15px">${body}</p>` +
          `<p style="color:#6b7280;font-size:12px;margin-top:12px">CGuardPro</p>`;
        await sendMail({ to: guardUser.email, subject: title, html, text: body });
        channels.email = true;
      }
    } catch { /* email optional */ }

    const sent = channels.inApp || channels.push || channels.email;
    if (sent) notified++;
    try {
      await item.update({ notifyStatus: sent ? 'sent' : 'failed', channels, notifiedAt: new Date() });
    } catch { /* ignore */ }
  }

  try {
    await db.implementationPlan.update(
      { notifiedGuards: notified, status: notified === items.length ? 'notified' : notified > 0 ? 'partial' : 'failed' },
      { where: { id: planId, tenantId } },
    );
  } catch { /* ignore */ }

  return notified;
}

/** Load the implementation plan for a published proposal (with guard names). */
export async function getImplementationPlan(db: any, tenantId: string, proposalId: string) {
  const plan = await db.implementationPlan.findOne({
    where: { proposalId, tenantId },
    order: [['createdAt', 'DESC']],
  });
  if (!plan) return null;
  const items = await db.implementationPlanItem.findAll({
    where: { planId: plan.id, tenantId },
    include: [{ model: db.user, as: 'guard', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
    order: [['changed', 'DESC'], ['added', 'DESC']],
  });
  return {
    plan: plan.get({ plain: true }),
    items: items.map((i: any) => {
      const p = i.get({ plain: true });
      const g = p.guard || {};
      return { ...p, guardName: g.fullName || [g.firstName, g.lastName].filter(Boolean).join(' ') || 'Guardia' };
    }),
  };
}

/** Discard a draft proposal (no effect on live shifts). */
export async function discardProposal(db: any, tenantId: string, userId: string, proposalId: string) {
  const proposal = await db.scheduleProposal.findOne({ where: { id: proposalId, tenantId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'published') throw new Error('Cannot discard a published proposal');
  await proposal.update({ status: 'discarded' });
  return { discarded: true };
}
