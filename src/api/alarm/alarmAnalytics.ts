/**
 * GET /tenant/:tenantId/alarm/analytics?days=30
 * Monitoring operation analytics: volume, response times (TTA/TTD/TTR), SLA-ack
 * compliance, escalation + false-alarm rate, category/priority/trend breakdowns,
 * operator leaderboard, dispatch + ECV stats. Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { Op } from 'sequelize';

const SLA_MINS: Record<number, number> = { 1: 2, 2: 5, 3: 15, 4: 30, 5: 60 };
const secs = (a: any, b: any): number | null =>
  a && b ? Math.max(0, Math.round((new Date(a).getTime() - new Date(b).getTime()) / 1000)) : null;
const avg = (arr: number[]): number => (arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : 0);

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Lean scan: only the scalar columns the aggregation below reads — never
    // the stepProgress JSON blob (detail-only; caseList drops it too). raw:true
    // skips Sequelize instance hydration since we only read plain values.
    const cases = await db.alarmCase.findAll({
      where: { tenantId, createdAt: { [Op.gte]: since } },
      attributes: [
        'status',
        'priority',
        'category',
        'assignedOperatorId',
        'ackAt',
        'dispatchAt',
        'resolvedAt',
        'closedAt',
        'disposition',
        'slaLevel',
        'ecvSatisfied',
        'createdAt',
      ],
      raw: true,
    });

    const tta: number[] = [], ttd: number[] = [], ttr: number[] = [];
    let ackWithinSla = 0, ackedCount = 0, escalated = 0;
    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const trendMap: Record<string, number> = {};
    const disp: Record<string, number> = { real: 0, false: 0, test: 0, runaway: 0, cancelled: 0 };
    const opMap: Record<string, { handled: number; tta: number[]; ttd: number[] }> = {};
    let ecvCases = 0;

    for (const c of cases) {
      const a = secs(c.ackAt, c.createdAt);
      if (a != null) { tta.push(a); ackedCount += 1; if (a <= (SLA_MINS[c.priority] || 15) * 60) ackWithinSla += 1; }
      const d = secs(c.dispatchAt, c.createdAt); if (d != null) ttd.push(d);
      const r = secs(c.resolvedAt || c.closedAt, c.createdAt); if (r != null) ttr.push(r);
      if ((c.slaLevel || 0) > 0) escalated += 1;
      if (c.ecvSatisfied) ecvCases += 1;
      byCategory[c.category || 'desconocido'] = (byCategory[c.category || 'desconocido'] || 0) + 1;
      byPriority['P' + (c.priority || 3)] = (byPriority['P' + (c.priority || 3)] || 0) + 1;
      const day = new Date(c.createdAt).toISOString().slice(0, 10);
      trendMap[day] = (trendMap[day] || 0) + 1;
      if (c.disposition && c.disposition in disp) disp[c.disposition] += 1;
      if (c.assignedOperatorId) {
        const o = opMap[c.assignedOperatorId] || (opMap[c.assignedOperatorId] = { handled: 0, tta: [], ttd: [] });
        o.handled += 1; if (a != null) o.tta.push(a); if (d != null) o.ttd.push(d);
      }
    }

    const total = cases.length;
    const openCount = cases.filter((c: any) => !['resolved', 'closed'].includes(c.status)).length;
    const dispTotal = Object.values(disp).reduce((s, x) => s + x, 0);

    // Operator names.
    const opIds = Object.keys(opMap);
    let users: any[] = [];
    if (opIds.length) {
      users = await db.user.findAll({ where: { id: opIds }, attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] });
    }
    const nameOf = (id: string) => {
      const u = users.find((x: any) => x.id === id);
      if (!u) return 'Operador';
      return (u.fullName && u.fullName.trim()) || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Operador';
    };
    const operators = opIds
      .map((id) => ({ operatorId: id, name: nameOf(id), handled: opMap[id].handled, avgTtaSec: avg(opMap[id].tta), avgTtdSec: avg(opMap[id].ttd) }))
      .sort((x, y) => y.handled - x.handled);

    // Dispatch + ECV totals.
    const dispatches = await db.alarmDispatch.findAll({ where: { tenantId, createdAt: { [Op.gte]: since } }, attributes: ['type'] });
    const dispatchByType: Record<string, number> = { guard: 0, police: 0, fire: 0, medical: 0 };
    for (const dp of dispatches) if (dp.type in dispatchByType) dispatchByType[dp.type] += 1;
    const totalCalls = await db.alarmCallLog.count({ where: { tenantId, createdAt: { [Op.gte]: since } } });

    const trend = Object.keys(trendMap).sort().map((k) => ({ k: k.slice(5), v: trendMap[k] }));

    await ApiResponseHandler.success(req, res, {
      days,
      total,
      open: openCount,
      avgTtaSec: avg(tta),
      avgTtdSec: avg(ttd),
      avgTtrSec: avg(ttr),
      slaAckCompliance: ackedCount ? Math.round((ackWithinSla / ackedCount) * 1000) / 10 : 0,
      escalationRate: total ? Math.round((escalated / total) * 1000) / 10 : 0,
      falseRate: dispTotal ? Math.round(((disp.false + disp.runaway) / dispTotal) * 1000) / 10 : 0,
      byCategory,
      byPriority,
      trend,
      operators,
      dispatchByType,
      ecvSatisfiedCases: ecvCases,
      totalCalls,
      disposition: disp,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
