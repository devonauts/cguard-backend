import fs from 'fs';
import path from 'path';
import models from '../database/models';

async function ensureUploadsDir(uploadDir: string) {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

export async function processPendingJobs() {
  const db = models();
  const uploadDir = path.resolve(__dirname, '../../uploads');
  await ensureUploadsDir(uploadDir);

  try {
    const pending = await db.reportJob.findAll({ where: { status: 'pending' }, limit: 10 });
    for (const job of pending) {
      try {
        await job.update({ status: 'processing', startedAt: new Date() });

        const params = job.params || {};
        const where: any = {};
        if (job.tenantId) where.tenantId = job.tenantId;
        const Op = db.Sequelize.Op;
        if (params.start || params.end) {
          const r: any = {};
          if (params.start) r[Op.gte] = new Date(String(params.start));
          if (params.end) r[Op.lte] = new Date(String(params.end));
          where.createdAt = r;
        }

        const rows = await db.report.findAll({ where, order: [['createdAt', 'ASC']], limit: 5000 });

        // Build CSV
        const headers = ['id', 'title', 'type', 'stationId', 'createdAt', 'officerName'];
        const csvLines = [headers.join(',')];
        for (const r of rows) {
          const vals = [
            String(r.id || ''),
            `"${String((r.title || '').toString()).replace(/"/g, '""')}"`,
            String(r.type || ''),
            String(r.stationId || ''),
            (r.createdAt ? (new Date(r.createdAt)).toISOString() : ''),
            String(r.officerName || r.officer || ''),
          ];
          csvLines.push(vals.join(','));
        }

        const filename = `report_${job.id}.csv`;
        const outPath = path.join(uploadDir, filename);
        fs.writeFileSync(outPath, csvLines.join('\n'), { encoding: 'utf8' });
        const stats = fs.statSync(outPath);

        // create file record
        const fileRec = await db.file.create({
          belongsTo: 'reportJob',
          belongsToId: job.id,
          belongsToColumn: 'result',
          name: filename,
          sizeInBytes: Number(stats.size),
          publicUrl: `/uploads/${filename}`,
          tenantId: job.tenantId || null,
          mimeType: 'text/csv',
          createdById: job.createdById || null,
        });

        await job.update({ status: 'completed', finishedAt: new Date(), resultUrl: fileRec.publicUrl });
      } catch (e) {
        try {
          await job.update({ status: 'failed', finishedAt: new Date() });
        } catch (_) {}
      }
    }
  } finally {
    // close sequelize connection
    try {
      const { sequelize } = db;
      if (sequelize && typeof sequelize.close === 'function') await sequelize.close();
    } catch (_) {}
  }
}

export default { processPendingJobs };
