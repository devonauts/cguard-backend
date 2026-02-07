import ApiResponseHandler from '../apiResponseHandler';
import KpiService from '../../services/kpiService';
import BusinessInfoRepository from '../../database/repositories/businessInfoRepository';

// Generate PDF from HTML using Puppeteer (on-demand)
export default async (req, res, next) => {
  try {
    const service = new KpiService(req);
    const kpi = await service.findById(req.params.id);

    if (!kpi) {
      return await ApiResponseHandler.error(req, res, 'KPI not found');
    }

    // Try to require puppeteer or puppeteer-core
    let puppeteer;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      puppeteer = require('puppeteer');
    } catch (err1) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        puppeteer = require('puppeteer-core');
      } catch (err2) {
        console.error('puppeteer not installed. Install with `npm install puppeteer` to enable HTML->PDF generation.');
        return await ApiResponseHandler.error(req, res, 'PDF generation not available (puppeteer not installed)');
      }
    }

    // Tenant info (set by tenantMiddleware as req.currentTenant)
    const tenant = req.currentTenant || {};

    // Prepare fields for the template
    // Prefer the postSite/businessName as the client name, then guard, then any explicit clientName, then addedBy
    let clientName = (kpi.postSite && (kpi.postSite.businessName || kpi.postSite.name)) || (kpi.guard && kpi.guard.fullName) || kpi.clientName || kpi.addedBy || '';

    // If a postSite is associated, try fetching its full record and prefer its name.
    try {
      if (kpi.postSite && kpi.postSite.id) {
        const fullPostSite = await BusinessInfoRepository.findById(kpi.postSite.id, service.options);
        if (fullPostSite) {
          // Prefer the client account name attached to the postSite (owner of the postSite),
          // then fall back to company/business/name fields on the postSite itself.
          clientName = fullPostSite.clientAccountName || fullPostSite.companyName || fullPostSite.businessName || fullPostSite.name || clientName;
          // Also compute a postSite display name to use in the PDF header (the post site name itself)
          var postSiteName = fullPostSite.companyName || fullPostSite.businessName || fullPostSite.name || (kpi.postSite && (kpi.postSite.businessName || kpi.postSite.name)) || '';
        }
      }
    } catch (e) {
      // ignore errors and keep existing fallback
    }
    // Ensure postSiteName is defined even if we couldn't fetch full record
    postSiteName = postSiteName || (kpi.postSite && (kpi.postSite.businessName || kpi.postSite.name)) || '';
    // For guard-scope KPIs we must not include any client/postSite data
    const clientLabel = kpi.scope === 'guard' ? 'Guard' : 'Client Name';
    if (kpi.scope === 'guard') {
      clientName = (kpi.guard && kpi.guard.fullName) || kpi.addedBy || '';
      postSiteName = '';
    }
    const addedBy = kpi.addedBy || kpi.addedBy || '';
    const typeLabel = kpi.frequency || '';
    const pdfType = kpi.scope === 'postSite' ? 'Post Site KPI Report' : kpi.scope === 'guard' ? 'Guard KPI Report' : 'KPI Report';
    const dateTime = kpi.dateTime ? new Date(kpi.dateTime).toLocaleString() : '';

    // Determine start/end date to display in the PDF.
    // Rule: Use explicit KPI fields if present; otherwise use `createdAt` as start
    // and the last second of the createdAt month as end.
    let startDate = '';
    let endDate = '';

    if (kpi.startDate) {
      startDate = new Date(kpi.startDate).toLocaleString();
    }
    if (kpi.endDate) {
      endDate = new Date(kpi.endDate).toLocaleString();
    }

    if (!startDate || !endDate) {
      const createdAtDate = kpi.createdAt ? new Date(kpi.createdAt) : (kpi.dateTime ? new Date(kpi.dateTime) : new Date());
      if (!startDate) {
        startDate = createdAtDate.toLocaleString();
      }
      if (!endDate) {
        // compute last minute (23:59) of the month of createdAtDate in local time
        const year = createdAtDate.getFullYear();
        const monthIndex = createdAtDate.getMonth();
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        // set to last day of month at 23:59:59 local time
        const endInclusive = new Date(year, monthIndex, lastDay, 23, 59, 59);
        // format as local date + hour:minute:second to show 23:59:59
        const datePart = endInclusive.toLocaleDateString();
        const hh = String(endInclusive.getHours()).padStart(2, '0');
        const mm = String(endInclusive.getMinutes()).padStart(2, '0');
        const ss = String(endInclusive.getSeconds()).padStart(2, '0');
        endDate = `${datePart} ${hh}:${mm}:${ss}`;
      }
    }
    const description = kpi.description || '';

    // Collect all metrics that have an explicit positive target
    const metricsDef = [
      { key: 'standardReportsNumber', label: 'Standard Reports' },
      { key: 'taskReportsNumber', label: 'Task Reports' },
      { key: 'incidentReportsNumber', label: 'Incident Reports' },
      { key: 'routeReportsNumber', label: 'Route Reports' },
      { key: 'verificationReportsNumber', label: 'Checklist Reports' },
    ];

    const metrics = metricsDef.map((m) => {
      const val = kpi[m.key];
      return {
        key: m.key,
        label: m.label,
        target: val !== undefined && val !== null ? Number(val) : null,
        actual: Number(kpi.actual || 0),
      };
    }).filter(m => m.target !== null && m.target > 0);

    const chartHeight = 200; // base px
    const chartMax = Math.max(1, ...metrics.flatMap(m => [m.target || 0, m.actual || 0]));
    // Adjust sizing when many metrics so chart + table fit on one A4 page
    const many = metrics.length > 4;
    const baseFontSize = many ? '12px' : '14px';
    const axisFontSize = many ? 10 : 12;
    const chartInnerHeight = many ? 180 : 260; // inner plotting area height
    const svgHeight = chartInnerHeight + 80; // svg total height

    // Build a more structured HTML that follows the sample layout and includes an SVG bar chart
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #111827; font-size: ${baseFontSize}; }
            h2.title { font-size: 18px; margin: 0 0 12px 0 }
            table.meta { width: 100%; border-collapse: collapse; margin-bottom: 16px }
            table.meta td { border: 1px solid #ddd; padding: 12px; vertical-align: top; }
            table.meta th { border: 1px solid #ddd; padding: 12px; background: #f3f4f6; text-align: left }
            table.kpi { width: 100%; border-collapse: collapse; margin-top: 8px }
            table.kpi th, table.kpi td { border: 1px solid #ddd; padding: 12px; }
            .chart { margin-top: 20px; }
            .small { font-size: ${many ? '11px' : '12px'}; color: #6b7280 }
            .client-header { font-weight:700; margin-top:10px; margin-bottom:14px; font-size:16px }
            .tenant-header { display:flex; align-items:center; gap:16px; background:#f8fafc; padding:20px; border-radius:12px; margin-bottom:24px }
            .title-box { background:#eef6fb; padding:10px 16px; border-radius:8px; display:inline-block; font-weight:700; margin-top:6px; margin-bottom:8px }
            .tenant-logo { width:64px; height:64px; background:#fff; border-radius:10px; border:1px solid #eef2f7 }
            .tenant-center { flex:1; text-align:center }
            .tenant-right { min-width:160px; text-align:right; font-size:14px; display:flex; flex-direction:column; gap:4px }
            .footer-fixed { position: fixed; right: 24px; bottom: 18px; font-size: 12px; color: #6b7280 }
          </style>
        </head>
        <body>
          <div class="tenant-header">
            <div class="tenant-logo"></div>
            <div class="tenant-center">
              <div style="font-weight:700">${(tenant.businessTitle || tenant.name || '').replace(/</g, '&lt;')}</div>
              <div class="small">${(tenant.address || tenant.extraLines || '').replace(/</g, '&lt;')}</div>
            </div>
            <div class="tenant-right">
              <div>${(tenant.phone || process.env.TENANT_PHONE || process.env.MAIL_DEFAULT_PHONE || '')}</div>
              <div>${(tenant.email || process.env.MAIL_DEFAULT_SENDER || '')}</div>
              <div>${tenant.website || ''}</div>
            </div>
          </div>

          <div class="title-box">${pdfType}</div>

          ${postSiteName ? `<div class="client-header">1. ${postSiteName.replace(/</g, '&lt;')}</div>` : ''}

          <table class="meta">
            <tr>
              <th>${clientLabel}</th>
              <th>Type</th>
            </tr>
            <tr>
              <td>${clientName.replace(/</g, '&lt;')}</td>
              <td>${typeLabel || pdfType}</td>
            </tr>
            <tr>
              <th>Date/Time</th>
              <th>Added By</th>
            </tr>
            <tr>
              <td>${dateTime}</td>
              <td>${kpi.addedBy || ''}</td>
            </tr>
            <tr>
              <th>Start Date Time</th>
              <th>End Date Time</th>
            </tr>
            <tr>
              <td>${startDate}</td>
              <td>${endDate}</td>
            </tr>
          </table>

          <table class="kpi">
            <thead>
              <tr><th>Name</th><th>Target</th><th>Actual</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${metrics.map(m => `
                <tr>
                  <td>${m.label}</td>
                  <td>${m.target}</td>
                  <td>${m.actual}</td>
                  <td>${m.target !== null && m.actual >= m.target ? 'Achieved' : 'Not Achieved'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <div class="chart">
            <svg width="700" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
              <rect x="40" y="20" width="620" height="${chartInnerHeight}" fill="none" stroke="#eee" />
              <!-- grid lines -->
              ${[0,0.2,0.4,0.6,0.8,1].map((g) => `
                <line x1="40" y1="${20 + (1 - g) * chartInnerHeight}" x2="660" y2="${20 + (1 - g) * chartInnerHeight}" stroke="#eee" stroke-width="1" />
              `).join('')}

              ${(() => {
                if (!metrics.length) return '';
                const left = 40;
                const width = 620;
                const count = metrics.length;
                const gap = Math.max(16, Math.floor(width / (count * 5)));
                const barSlot = Math.floor(width / count);
                const barWidth = Math.min(120, Math.max(24, Math.floor(barSlot * 0.6)));
                return metrics.map((m, i) => {
                  const cx = left + i * barSlot + Math.floor((barSlot - barWidth) / 2);
                  const targetH = Math.round(((m.target || 0) / chartMax) * chartInnerHeight);
                  const actualH = Math.round((m.actual / chartMax) * chartInnerHeight);
                  const targetY = 20 + (chartInnerHeight - targetH);
                  const actualY = 20 + (chartInnerHeight - actualH);
                  const tx = cx + Math.floor(barWidth / 2);
                  return `
                    <rect x="${cx}" y="${targetY}" width="${barWidth}" height="${targetH}" fill="#6b7280" />
                    <rect x="${cx + Math.floor(barWidth/6)}" y="${actualY}" width="${Math.floor(barWidth*0.6)}" height="${actualH}" fill="#10b981" />
                    <text x="${tx}" y="${20 + (chartInnerHeight - targetH) - 10}" font-size="${axisFontSize}" fill="#374151" text-anchor="middle">${m.target}</text>
                    <text x="${tx}" y="${20 + (chartInnerHeight - actualH) - 10}" font-size="${axisFontSize}" fill="#059669" text-anchor="middle">${m.actual}</text>
                    <text x="${tx}" y="${20 + chartInnerHeight + 25}" font-size="${axisFontSize}" fill="#111827" text-anchor="middle">${m.label}</text>
                  `;
                }).join('');
              })()}

            </svg>
          </div>

          <div class="footer-fixed">Generated by cguard</div>
        </body>
      </html>
    `;

    // Launch puppeteer; allow configuring executablePath via env (for puppeteer-core)
    const launchArgs = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchArgs['executablePath'] = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const browser = await puppeteer.launch(launchArgs);
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

      // Send PDF with explicit headers
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="kpi-${kpi.id}.pdf"`);
      res.setHeader('Content-Length', String(pdfBuffer.length));
      res.end(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(error);
    await ApiResponseHandler.error(req, res, error);
  }
};
