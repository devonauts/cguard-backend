/**
 * GET /tenant/:tenantId/alarm/reports/false-alarms?days=30
 * Disposition breakdown (real / false / test / runaway / cancelled) overall and
 * per panel, with a false-alarm rate. Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { Op } from 'sequelize';

const ZERO = () => ({ total: 0, real: 0, false: 0, test: 0, runaway: 0, cancelled: 0 });
const rate = (b: any) => (b.total ? Math.round(((b.false + b.runaway) / b.total) * 1000) / 10 : 0);

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const cases = await db.alarmCase.findAll({
      where: { tenantId, createdAt: { [Op.gte]: since }, disposition: { [Op.ne]: null } },
      include: [{ model: db.alarmPanel, as: 'panel', attributes: ['id', 'name', 'accountNumber'], required: false }],
    });

    const overall: any = ZERO();
    const byPanel: Record<string, any> = {};
    for (const c of cases || []) {
      const d = String(c.disposition);
      overall.total += 1;
      if (d in overall) overall[d] += 1;
      const pid = c.alarmPanelId || 'unknown';
      if (!byPanel[pid]) {
        byPanel[pid] = {
          panelId: pid,
          panelName: (c.panel && c.panel.name) || '—',
          accountNumber: (c.panel && c.panel.accountNumber) || null,
          ...ZERO(),
        };
      }
      byPanel[pid].total += 1;
      if (d in byPanel[pid]) byPanel[pid][d] += 1;
    }

    const panels = Object.values(byPanel)
      .map((b: any) => ({ ...b, falseRate: rate(b) }))
      .sort((a: any, b: any) => b.falseRate - a.falseRate || b.total - a.total);

    await ApiResponseHandler.success(req, res, {
      days,
      overall: { ...overall, falseRate: rate(overall) },
      panels,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
