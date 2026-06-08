/**
 * GET /tenant/:tenantId/alarm/reports/audit-export?days=30
 * The immutable alarm activity log over a period, with case/panel/actor context —
 * the UL/TMA-style compliance trail. Returns JSON rows (the client renders CSV).
 * Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import { Op } from 'sequelize';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await db.alarmAuditLog.findAll({
      where: { tenantId, at: { [Op.gte]: since } },
      include: [
        {
          model: db.alarmCase,
          as: 'case',
          required: false,
          attributes: ['id', 'title', 'category', 'priority', 'status', 'disposition'],
          include: [{ model: db.alarmPanel, as: 'panel', required: false, attributes: ['name', 'accountNumber'] }],
        },
      ],
      order: [['at', 'DESC']],
      limit: 5000,
    });

    const actorIds = Array.from(new Set((logs || []).map((l: any) => l.actorId).filter(Boolean)));
    let users: any[] = [];
    if (actorIds.length) {
      users = await db.user.findAll({ where: { id: actorIds }, attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] });
    }
    const nameOf = (id: string) => {
      const u = users.find((x: any) => x.id === id);
      if (!u) return 'operador';
      return (u.fullName && u.fullName.trim()) || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'operador';
    };

    const rows = (logs || []).map((l: any) => ({
      at: l.at,
      action: l.action,
      detail: l.detail,
      actor: l.actorId ? nameOf(l.actorId) : 'sistema',
      caseId: l.alarmCaseId,
      caseTitle: l.case ? l.case.title : null,
      category: l.case ? l.case.category : null,
      priority: l.case ? l.case.priority : null,
      status: l.case ? l.case.status : null,
      disposition: l.case ? l.case.disposition : null,
      panel: l.case && l.case.panel ? l.case.panel.name : null,
      account: l.case && l.case.panel ? l.case.panel.accountNumber : null,
    }));

    await ApiResponseHandler.success(req, res, { days, count: rows.length, rows });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
