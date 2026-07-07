/**
 * Daily ops heartbeat digest — one email a day summarizing platform health, so
 * "everything is fine" is something you RECEIVE, not something you have to go
 * check. It doubles as a dead-man's-switch: if the digest stops arriving, the
 * box (or mail) is down. Leader-elected, sent once per day at ALERT_DIGEST_HOUR
 * (default 08:00 server time) to ALERT_EMAIL_TO. All local, no cloud.
 */
let lastSentDay: string | null = null;

const mb = (b: number) => `${Math.round((b || 0) / 1048576)}MB`;

/** Called hourly on the leader; sends the digest once when the target hour hits. */
export async function sendDigestIfDue(): Promise<void> {
  try {
    const hour = Number(process.env.ALERT_DIGEST_HOUR || 8);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== hour) return;
    if (lastSentDay === day) return; // already sent today
    lastSentDay = day;
    await sendDailyDigest();
  } catch (e: any) {
    console.error('[opsDigest]', e?.message || e);
  }
}

export async function sendDailyDigest(): Promise<void> {
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  const models = require('../database/models').default;
  const db = models();
  const { Op } = db.Sequelize;
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  // Metrics rollup over 24h.
  let peakRss = 0, maxHostMem = 0, maxHeap = 0, maxLoad = 0, lastDisk = 0, sumErr = 0, maxPoolWait = 0, points = 0;
  try {
    const rows: any[] = await db.metricsSnapshot.findAll({
      where: { createdAt: { [Op.gte]: since } },
      attributes: ['rss', 'hostMemPct', 'heapUsedPct', 'loadPct', 'diskPct', 'errorCount', 'dbPoolWaiting'],
      raw: true,
    });
    points = rows.length;
    for (const r of rows) {
      peakRss = Math.max(peakRss, Number(r.rss || 0));
      maxHostMem = Math.max(maxHostMem, Number(r.hostMemPct || 0));
      maxHeap = Math.max(maxHeap, Number(r.heapUsedPct || 0));
      maxLoad = Math.max(maxLoad, Number(r.loadPct || 0));
      lastDisk = Number(r.diskPct || lastDisk);
      sumErr += Number(r.errorCount || 0);
      maxPoolWait = Math.max(maxPoolWait, Number(r.dbPoolWaiting || 0));
    }
  } catch { /* ignore */ }

  const errors24 = await db.errorEvent?.count({ where: { createdAt: { [Op.gte]: since } } }).catch(() => 0);
  const alerts24 = await db.superadminNotification?.count({ where: { type: { [Op.like]: 'alert.%' }, createdAt: { [Op.gte]: since } } }).catch(() => 0);
  const jobErrors = (() => { try { return require('./jobsMonitor').getJobs().filter((j: any) => j.lastStatus === 'error').length; } catch { return 0; } })();
  const backup = (() => { try { return require('./dbBackup').getBackupStatus(); } catch { return null; } })();

  const backupLine = backup?.recent?.[0]
    ? `${new Date(backup.recent[0].at).toLocaleString('es-EC')} (${mb(backup.recent[0].sizeBytes)})`
    : '⚠️ sin copias';

  // Overall banner: green unless something crossed a line in the last day.
  const problems = (errors24 || 0) > 50 || maxHostMem >= 92 || maxHeap >= 92 || maxPoolWait > 0 || jobErrors > 0 || !backup?.recent?.length;
  const banner = problems ? '🟡 Revisar' : '🟢 Todo en orden';

  const row = (k: string, v: string) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${k}</td><td style="padding:4px 0;font-weight:600">${v}</td></tr>`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Resumen diario · CGuardPro <span style="font-weight:400">${banner}</span></h2>
    <p style="color:#94a3b8;margin:0 0 12px;font-size:12px">Últimas 24h · ${points} muestras</p>
    <table style="border-collapse:collapse;font-size:14px">
      ${row('Errores (24h)', String(errors24 || 0))}
      ${row('Alertas disparadas (24h)', String(alerts24 || 0))}
      ${row('Tareas fallando', jobErrors ? `⚠️ ${jobErrors}` : '0')}
      ${row('RAM host (máx)', `${maxHostMem}%`)}
      ${row('Heap proceso (máx, del límite)', `${maxHeap}%`)}
      ${row('RSS pico', mb(peakRss))}
      ${row('Carga CPU (máx)', `${maxLoad}%`)}
      ${row('Disco', `${lastDisk}%`)}
      ${row('Pool BD en espera (máx)', String(maxPoolWait))}
      ${row('Última copia BD', backupLine)}
    </table>
    <p style="color:#94a3b8;font-size:11px;margin-top:12px">Si este correo deja de llegar, algo está caído. Umbrales/alertas en el panel de Observabilidad.</p>
  </div>`;

  try {
    const { enqueueMail } = require('../services/mailService');
    await enqueueMail({ to, subject: `${banner} Resumen diario CGuardPro`, html, text: `Errores 24h: ${errors24}. RAM máx ${maxHostMem}%. RSS pico ${mb(peakRss)}. Última copia: ${backupLine}.` });
    console.log('[opsDigest] daily digest sent');
  } catch (e: any) {
    console.error('[opsDigest] send failed:', e?.message || e);
  }
}
