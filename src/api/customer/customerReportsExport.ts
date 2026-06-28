/**
 * Exportable customer reports.
 *   GET /api/customer/reports/export?type=incidents|patrols|hours&format=csv|pdf&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Auth = the customer JWT (currentUser.clientAccountId). Every row is strictly
 * scoped to the customer's OWN stations (resolved exactly like
 * customerSafety.resolveCustomerStations).
 *
 * Formats:
 *   - csv : built manually (no dependency) — header row + data rows, RFC-4180
 *           quoting. Content-Type: text/csv + Content-Disposition: attachment.
 *   - pdf : rendered with `pdfkit` (already a project dependency — see
 *           src/api/request/requestExportPdf.ts), a simple branded table.
 *           Streamed straight to the response.
 *
 * Report types:
 *   incidents : date, title, priority, status, station
 *   patrols   : scheduledTime, completed, status, guard, station
 *   hours     : per-guard punch-in/out totals (shifts, hours, station) from guardShift
 */
import PDFDocument from 'pdfkit';
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    clientAccountId,
  };
};

async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();
  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));

  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }

  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'stationName'],
      })
    : [];
  return { stationIds: ids, stations };
}

function parseDate(v: any, def: Date): Date {
  if (!v) return def;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? def : d;
}

/** Format a Date for human-readable cells (YYYY-MM-DD HH:mm). */
function fmtDateTime(v: any): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** RFC-4180 cell quoting: wrap in quotes + escape inner quotes when needed. */
function csvCell(v: any): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

interface ReportData {
  title: string;
  headers: string[];
  rows: (string | number)[][];
}

/** Build the chosen report's headers + rows (already resolved/labelled). */
async function buildReport(
  db: any,
  tenantId: string,
  type: string,
  stationIds: string[],
  stationNameById: Map<string, string>,
  start: Date,
  end: Date,
): Promise<ReportData> {
  if (type === 'patrols') {
    const rows = await db.patrol.findAll({
      where: {
        stationId: { [Op.in]: stationIds },
        ...(tenantId ? { tenantId } : {}),
        scheduledTime: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['id', 'scheduledTime', 'completed', 'status', 'stationId', 'assignedGuardId'],
      order: [['scheduledTime', 'DESC']],
      limit: 5000,
    });
    const guardIds = Array.from(new Set((rows || []).map((r: any) => String(r.assignedGuardId || '')).filter(Boolean)));
    const guards = guardIds.length
      ? await db.user.findAll({ where: { id: { [Op.in]: guardIds } }, attributes: ['id', 'fullName', 'firstName', 'lastName', 'email'] })
      : [];
    const guardNameById = new Map<string, string>(
      guards.map((g: any) => [String(g.id), g.fullName || [g.firstName, g.lastName].filter(Boolean).join(' ') || g.email || '']),
    );
    return {
      title: 'Reporte de rondas',
      headers: ['scheduledTime', 'completed', 'status', 'guard', 'station'],
      rows: (rows || []).map((r: any) => [
        fmtDateTime(r.scheduledTime),
        r.completed ? 'Sí' : 'No',
        r.status || '',
        guardNameById.get(String(r.assignedGuardId)) || '',
        stationNameById.get(String(r.stationId)) || '',
      ]),
    };
  }

  if (type === 'hours') {
    // Per-guard punch-in/out totals from guardShift (one row per guard+station).
    const shifts = await db.guardShift.findAll({
      where: {
        stationNameId: { [Op.in]: stationIds },
        ...(tenantId ? { tenantId } : {}),
        deletedAt: null,
        punchInTime: { [Op.gte]: start, [Op.lte]: end },
      },
      attributes: ['id', 'guardNameId', 'stationNameId', 'punchInTime', 'punchOutTime', 'hoursWorked'],
      order: [['punchInTime', 'DESC']],
      limit: 20000,
    });
    const guardIds = Array.from(new Set((shifts || []).map((s: any) => String(s.guardNameId || '')).filter(Boolean)));
    const guards = guardIds.length
      ? await db.securityGuard.findAll({ where: { id: { [Op.in]: guardIds } }, attributes: ['id', 'fullName'] })
      : [];
    const guardNameById = new Map<string, string>(guards.map((g: any) => [String(g.id), g.fullName || '']));

    // Aggregate by guard+station.
    const agg = new Map<string, { guard: string; station: string; shifts: number; hours: number }>();
    for (const s of shifts || []) {
      const key = `${s.guardNameId}|${s.stationNameId}`;
      let hours = s.hoursWorked != null ? Number(s.hoursWorked) : NaN;
      if (isNaN(hours)) {
        const inT = s.punchInTime ? new Date(s.punchInTime).getTime() : null;
        const outT = s.punchOutTime ? new Date(s.punchOutTime).getTime() : Date.now();
        hours = inT != null ? Math.max(0, (outT - inT) / 3600000) : 0;
      }
      const cur = agg.get(key) || {
        guard: guardNameById.get(String(s.guardNameId)) || '',
        station: stationNameById.get(String(s.stationNameId)) || '',
        shifts: 0,
        hours: 0,
      };
      cur.shifts += 1;
      cur.hours += hours;
      agg.set(key, cur);
    }
    return {
      title: 'Reporte de horas',
      headers: ['guard', 'station', 'shifts', 'totalHours'],
      rows: Array.from(agg.values())
        .sort((a, b) => b.hours - a.hours)
        .map((r) => [r.guard, r.station, r.shifts, Math.round(r.hours * 10) / 10]),
    };
  }

  // default: incidents
  const incidents = await db.incident.findAll({
    where: {
      stationId: { [Op.in]: stationIds },
      ...(tenantId ? { tenantId } : {}),
      deletedAt: null,
      date: { [Op.gte]: start, [Op.lte]: end },
    },
    attributes: ['id', 'date', 'title', 'priority', 'status', 'stationId'],
    order: [['date', 'DESC']],
    limit: 5000,
  });
  return {
    title: 'Reporte de incidentes',
    headers: ['date', 'title', 'priority', 'status', 'station'],
    rows: (incidents || []).map((r: any) => [
      fmtDateTime(r.date),
      r.title || '',
      r.priority || '',
      r.status || '',
      stationNameById.get(String(r.stationId)) || '',
    ]),
  };
}

/** Stream the report as a branded PDF table via pdfkit. */
function sendPdf(res: any, report: ReportData, rangeLabel: string, filenameBase: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  doc.pipe(res);

  const startX = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.page.margins.top;

  // Branded header band.
  doc.fillColor('#0f2747').rect(startX, y, pageWidth, 46).fill();
  doc.fillColor('#ffffff').fontSize(16).text(report.title, startX + 12, y + 8);
  doc.fillColor('#cbd5e1').fontSize(9).text(rangeLabel, startX + 12, y + 30);
  doc.fillColor('#ffffff').fontSize(9).text('Cguard', startX + pageWidth - 90, y + 8, { width: 80, align: 'right' });
  y += 60;

  // Column layout: even widths.
  const cols = report.headers.length;
  const colW = Math.floor(pageWidth / cols);
  const rowH = 20;

  const drawRow = (cells: (string | number)[], opts: { header?: boolean } = {}) => {
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (opts.header) {
      doc.fillColor('#e2e8f0').rect(startX, y, pageWidth, rowH).fill();
    }
    doc.lineWidth(0.5).strokeColor('#cbd5e1').rect(startX, y, pageWidth, rowH).stroke();
    cells.forEach((c, i) => {
      doc.fillColor(opts.header ? '#0f2747' : '#111')
        .fontSize(opts.header ? 9 : 8)
        .text(String(c == null ? '' : c), startX + i * colW + 4, y + 6, { width: colW - 8, ellipsis: true, lineBreak: false });
    });
    y += rowH;
  };

  drawRow(report.headers, { header: true });
  if (!report.rows.length) {
    doc.fillColor('#666').fontSize(10).text('Sin datos para el rango seleccionado.', startX + 4, y + 8);
  } else {
    for (const r of report.rows) drawRow(r);
  }

  // Footer (page numbers) on all buffered pages.
  try {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomY = doc.page.height - 28;
      doc.fontSize(8).fillColor('#666');
      doc.text(`Página ${i - range.start + 1} de ${range.count}`, startX, bottomY, { lineBreak: false });
      doc.text('Powered by Cguard', startX + pageWidth - 120, bottomY, { width: 120, align: 'right', lineBreak: false });
    }
  } catch { /* non-fatal */ }

  doc.end();
}

export default async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const q = req.query || {};

    const type = ['incidents', 'patrols', 'hours'].includes(String(q.type)) ? String(q.type) : 'incidents';
    const format = String(q.format) === 'pdf' ? 'pdf' : 'csv';

    const now = new Date();
    const end = parseDate(q.to, new Date(now));
    end.setHours(23, 59, 59, 999);
    const start = parseDate(q.from, new Date(now.getTime() - 29 * 86400000));
    start.setHours(0, 0, 0, 0);

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationNameById = new Map<string, string>(
      stations.map((s: any) => [String(s.id), s.stationName || 'Puesto']),
    );

    const dateOnly = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const rangeLabel = `${dateOnly(start)} → ${dateOnly(end)}`;
    const filenameBase = `${type}_${dateOnly(start)}_${dateOnly(end)}`;

    // No stations → still return a valid (empty) file so the client doesn't error.
    const report = stationIds.length
      ? await buildReport(db, tenantId, type, stationIds, stationNameById, start, end)
      : { title: `Reporte de ${type}`, headers: [], rows: [] as (string | number)[][] };

    if (format === 'pdf') {
      sendPdf(res, report, rangeLabel, filenameBase);
      return;
    }

    // CSV — manual build.
    const lines: string[] = [];
    lines.push(report.headers.map(csvCell).join(','));
    for (const row of report.rows) lines.push(row.map(csvCell).join(','));
    // Prepend a UTF-8 BOM so Excel renders accents (á, é, ñ) correctly.
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.status(200).send(csv);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
