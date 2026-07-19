import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';
import Sequelize from 'sequelize';
import { requireTenantId } from './index';

const Op = Sequelize.Op;

export default async (req, res, next) => {
  try {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const idParam = req.params.id;
    const dateStr = req.query.date;

    const service = new KpiService(req);
    const payload = await service.findAndCountAll({ limit: 100, orderBy: 'createdAt_DESC' });
    const rows = (payload && payload.rows) ? payload.rows : [];

    // Try to find KPI by id, otherwise treat idParam as index
    let selected: any = null;
    if (idParam) {
      selected = rows.find((r: any) => String(r.id) === String(idParam));
      if (!selected) {
        const idx = Number(idParam);
        if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) selected = rows[idx];
      }
    }

    // Build date range (UTC) for the requested date or today
    let start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    if (dateStr && typeof dateStr === 'string' && dateStr.length >= 10) {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        const y = Number(parts[0]);
        const m = Number(parts[1]) - 1;
        const d = Number(parts[2]);
        start = new Date(Date.UTC(y, m, d, 0, 0, 0));
      } else if (parts.length === 2) {
        // YYYY-MM -> use first day
        const y = Number(parts[0]);
        const m = Number(parts[1]) - 1;
        start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      }
    }
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 1);

    const whereReport: any = { tenantId, createdAt: { [Op.gte]: start, [Op.lt]: end } };

    // Count reports for this KPI/date (simple heuristic: count all reports for tenant on that day)
    let cnt = 0;
    try {
      cnt = await req.database.report.count({ where: whereReport });
    } catch (err) {
      // ignore
    }

    // Fetch recent report rows as detail items (limit 8)
    let details: any[] = [];
    try {
      const recs = await req.database.report.findAll({ where: whereReport, order: [['createdAt', 'DESC']], limit: 8 });
      details = recs.map((r: any) => ({ id: r.id, title: r.title || r.summary || r.type || 'Reporte', createdAt: r.createdAt }));
    } catch (err) {
      details = [];
    }

    const out = {
      id: selected?.id ?? null,
      title: selected?.description || selected?.type || selected?.scope || (selected ? 'KPI' : 'KPI'),
      value: String(cnt),
      trend: selected?.trend ?? null,
      details,
    };

    return ApiResponseHandler.success(req, res, out);
  } catch (error) {
    return ApiResponseHandler.error(req, res, error);
  }
};
