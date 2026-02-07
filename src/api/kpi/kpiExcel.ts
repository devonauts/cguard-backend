import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';
import BusinessInfoRepository from '../../database/repositories/businessInfoRepository';
import ExcelJS from 'exceljs';

// Generate an XLSX export for a single KPI
export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    const kpi = await service.findById(req.params.id);

    if (!kpi) {
      return await ApiResponseHandler.error(req, res, 'KPI not found');
    }

    // Try to get full postSite record
    let fullPostSite = null;
    try {
      if (kpi.postSite && kpi.postSite.id) {
        fullPostSite = await BusinessInfoRepository.findById(kpi.postSite.id, service.options);
      }
    } catch (e) {
      // ignore and continue with available data
    }

    // Compose fields
    const clientName = (fullPostSite && (fullPostSite as any).clientAccountName) || (kpi.postSite && (kpi.postSite.businessName || kpi.postSite.name)) || (kpi.guard && kpi.guard.fullName) || kpi.clientName || kpi.addedBy || '';
    const postSiteName = (fullPostSite && ((fullPostSite as any).companyName || (fullPostSite as any).businessName || (fullPostSite as any).name)) || (kpi.postSite && (kpi.postSite.businessName || kpi.postSite.name)) || '';
    // For guard-scope KPIs, do not include client/postSite data. Use 'Guard' label instead of 'Client Name'.
    const clientLabel = kpi.scope === 'guard' ? 'Guard' : 'Client Name';
    let displayClientName = clientName;
    if (kpi.scope === 'guard') {
      displayClientName = (kpi.guard && kpi.guard.fullName) || kpi.addedBy || '';
    }
    const typeLabel = kpi.frequency || '';
    const dateTime = kpi.dateTime ? new Date(kpi.dateTime).toLocaleString() : (kpi.createdAt ? new Date(kpi.createdAt).toLocaleString() : '');
    const addedBy = kpi.addedBy || '';

    // Build XLSX workbook using exceljs
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('KPI');

    // Metadata rows (match PDF layout)
    sheet.addRow([clientLabel, 'Type']);
    sheet.addRow([displayClientName, typeLabel]);
    sheet.addRow(['Date/Time', 'Added By']);
    sheet.addRow([dateTime, addedBy]);

    // Start / End DateTime (compute fallbacks like PDF)
    const start = kpi.startDate ? new Date(kpi.startDate) : (kpi.createdAt ? new Date(kpi.createdAt) : null);
    let end = kpi.endDate ? new Date(kpi.endDate) : null;
    if (!end && start) {
      end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
    }
    const startStr = start ? start.toLocaleString() : '';
    const endStr = end ? end.toLocaleString() : '';
    sheet.addRow(['Start Date Time', 'End Date Time']);
    sheet.addRow([startStr, endStr]);
    sheet.addRow([]);

    // KPI details header (match PDF)
    sheet.addRow(['Name', 'Target', 'Actual', 'Status']);

    const addReport = (label, targetVal, actualVal) => {
      const target = targetVal !== undefined && targetVal !== null ? Number(targetVal) : 0;
      const actual = actualVal !== undefined && actualVal !== null ? Number(actualVal) : 0;
      const status = actual >= target ? 'Achieved' : 'Not Achieved';
      sheet.addRow([label, target, actual, status]);
    };

    // Only include rows for report types that have an explicit target number in the DB
    // Only include rows when the numeric target is present and greater than zero
    const hasPositive = (v: any) => v !== undefined && v !== null && Number(v) > 0;
    if (hasPositive(kpi.standardReportsNumber)) {
      addReport('Standard Reports', kpi.standardReportsNumber, kpi.actual);
    }
    if (hasPositive(kpi.taskReportsNumber)) {
      addReport('Task Reports', kpi.taskReportsNumber, kpi.actual);
    }
    if (hasPositive(kpi.incidentReportsNumber)) {
      addReport('Incident Reports', kpi.incidentReportsNumber, kpi.actual);
    }
    if (hasPositive(kpi.routeReportsNumber)) {
      addReport('Route Reports', kpi.routeReportsNumber, kpi.actual);
    }
    if (hasPositive(kpi.verificationReportsNumber)) {
      addReport('Checklist Reports', kpi.verificationReportsNumber, kpi.actual);
    }

    // Auto-width columns
    sheet.columns.forEach((col) => {
      if (!col || !col.eachCell) return;
      let max = 10;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const val = cell.value as any;
        const len = val ? String(val).length : 0;
        if (len > max) max = len;
      });
      col.width = Math.min(Math.max(max + 2, 10), 60);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kpi-${kpi.id}.xlsx"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error(error);
    await ApiResponseHandler.error(req, res, error);
  }
};
