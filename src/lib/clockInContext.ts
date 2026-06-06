/**
 * Gathers the data shown in a guard clock-in notification/email: the site &
 * client (for recipients + display), the guard's note, open incidents at the
 * site, and the guard's pending memos / station consignas.
 *
 * Every lookup is best-effort — a clock-in must never fail because a related
 * record or association is missing, so each block swallows its own errors.
 */

import { isDueOn, ymd } from '../services/consignaRecurrence';

export interface ClockInContext {
  data: {
    guardName: string;
    stationName: string | null;
    siteName: string | null;
    clockInTime: string;
    observations: string | null;
    incidents: string[];
    pendingMemos: string[];
    pendingOrders: string[];
  };
  /** Extra email recipients beyond the role-targeted supervisors/admins. */
  extraEmails: string[];
}

export async function gatherClockInContext(
  db: any,
  opts: {
    tenantId: string;
    station: any; // station model instance: { id, stationName, postSiteId }
    securityGuard: any; // securityGuard instance: { id, fullName }
    observations?: string | null;
    clockInTime?: Date;
    // Pre-loaded tenant (email + timezone) from the caller — avoids re-fetching.
    tenant?: { email?: string | null; timezone?: string | null } | null;
  },
): Promise<ClockInContext> {
  const { tenantId } = opts;
  const station = opts.station || {};
  const stationId = station.id;
  const postSiteId = station.postSiteId || null;
  const when = opts.clockInTime || new Date();

  const data: ClockInContext['data'] = {
    guardName: opts.securityGuard?.fullName || 'Guardia',
    stationName: station.stationName || null,
    siteName: null,
    clockInTime: when.toISOString(),
    observations: opts.observations || null,
    incidents: [],
    pendingMemos: [],
    pendingOrders: [],
  };
  const extraEmails: string[] = [];

  // ── Site name + client account email ──────────────────────────────────────
  if (postSiteId) {
    let postSite: any = null;
    try {
      postSite = await db.businessInfo.findByPk(postSiteId, {
        attributes: ['id', 'companyName'],
        include: [{ model: db.clientAccount, as: 'clientAccount', attributes: ['email'] }],
      });
    } catch {
      try {
        postSite = await db.businessInfo.findByPk(postSiteId, {
          attributes: ['id', 'companyName'],
        });
      } catch {
        postSite = null;
      }
    }
    data.siteName = postSite?.companyName || null;
    if (postSite?.clientAccount?.email) extraEmails.push(postSite.clientAccount.email);
  }

  // ── Tenant email + timezone (timezone drives time display + consigna due) ──
  let tz = 'UTC';
  try {
    const tenant =
      opts.tenant ||
      (await db.tenant.findByPk(tenantId, { attributes: ['email', 'timezone'] }));
    if (tenant?.email) extraEmails.push(tenant.email);
    tz = tenant?.timezone || 'UTC';
  } catch {
    /* ignore */
  }
  try {
    data.clockInTime = when.toLocaleString('es', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    data.clockInTime = when.toISOString();
  }

  // ── Open incidents at this station / site ─────────────────────────────────
  try {
    const Op = db.Sequelize.Op;
    const or: any[] = [];
    if (stationId) or.push({ stationId });
    if (postSiteId) or.push({ postSiteId });
    if (or.length) {
      const incidents = await db.incident.findAll({
        where: { tenantId, status: 'abierto', deletedAt: null, [Op.or]: or },
        attributes: ['title'],
        order: [['createdAt', 'DESC']],
        limit: 20,
      });
      data.incidents = incidents.map((i: any) => i.title).filter(Boolean);
    }
  } catch {
    /* ignore */
  }

  // ── Pending memos the guard hasn't acknowledged ───────────────────────────
  try {
    if (opts.securityGuard?.id) {
      const memos = await db.memos.findAll({
        where: { guardNameId: opts.securityGuard.id, wasAccepted: false, tenantId, deletedAt: null },
        attributes: ['subject'],
        limit: 20,
      });
      data.pendingMemos = memos.map((m: any) => m.subject).filter(Boolean);
    }
  } catch {
    /* ignore */
  }

  // ── Consignas due today at this station, not yet completed ────────────────
  try {
    if (stationId) {
      const today = new Date();
      const occ = ymd(today, tz);
      const orders = await db.stationOrder.findAll({
        where: { tenantId, stationId, active: true, deletedAt: null },
      });
      const due = orders
        .map((o: any) => o.get({ plain: true }))
        .filter((o: any) => isDueOn(o, today, tz));
      if (due.length) {
        const completions = await db.stationOrderCompletion.findAll({
          where: {
            tenantId,
            occurrenceDate: occ,
            stationOrderId: due.map((o: any) => o.id).concat(['__none__']),
          },
          attributes: ['stationOrderId'],
        });
        const done = new Set(completions.map((c: any) => c.stationOrderId));
        data.pendingOrders = due
          .filter((o: any) => !done.has(o.id))
          .map((o: any) => o.title)
          .filter(Boolean);
      }
    }
  } catch {
    /* ignore */
  }

  return { data, extraEmails };
}

export interface ClockOutContext {
  data: {
    guardName: string;
    stationName: string | null;
    siteName: string | null;
    clockOutTime: string;
    observations: string | null;
  };
  /** Extra email recipients beyond the role-targeted supervisors/admins. */
  extraEmails: string[];
}

/**
 * Gathers the data shown in a guard clock-out notification/email: the site &
 * client (for recipients + display), the guard's end-of-shift note, and the
 * tenant contact. Leaner than the clock-in gather — no incidents/memos/consignas
 * are relevant when a shift ends. Best-effort: a clock-out must never fail
 * because a related record or association is missing.
 */
export async function gatherClockOutContext(
  db: any,
  opts: {
    tenantId: string;
    station: any; // station model instance: { id, stationName, postSiteId }
    securityGuard: any; // securityGuard instance: { id, fullName }
    observations?: string | null;
    clockOutTime?: Date;
    // Pre-loaded tenant (email + timezone) from the caller — avoids re-fetching.
    tenant?: { email?: string | null; timezone?: string | null } | null;
  },
): Promise<ClockOutContext> {
  const { tenantId } = opts;
  const station = opts.station || {};
  const postSiteId = station.postSiteId || null;
  const when = opts.clockOutTime || new Date();

  const data: ClockOutContext['data'] = {
    guardName: opts.securityGuard?.fullName || 'Guardia',
    stationName: station.stationName || null,
    siteName: null,
    clockOutTime: when.toISOString(),
    observations: opts.observations || null,
  };
  const extraEmails: string[] = [];

  // ── Site name + client account email ──────────────────────────────────────
  if (postSiteId) {
    let postSite: any = null;
    try {
      postSite = await db.businessInfo.findByPk(postSiteId, {
        attributes: ['id', 'companyName'],
        include: [{ model: db.clientAccount, as: 'clientAccount', attributes: ['email'] }],
      });
    } catch {
      try {
        postSite = await db.businessInfo.findByPk(postSiteId, {
          attributes: ['id', 'companyName'],
        });
      } catch {
        postSite = null;
      }
    }
    data.siteName = postSite?.companyName || null;
    if (postSite?.clientAccount?.email) extraEmails.push(postSite.clientAccount.email);
  }

  // ── Tenant email + timezone (timezone drives the time display) ─────────────
  let tz = 'UTC';
  try {
    const tenant =
      opts.tenant ||
      (await db.tenant.findByPk(tenantId, { attributes: ['email', 'timezone'] }));
    if (tenant?.email) extraEmails.push(tenant.email);
    tz = tenant?.timezone || 'UTC';
  } catch {
    /* ignore */
  }
  try {
    data.clockOutTime = when.toLocaleString('es', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    data.clockOutTime = when.toISOString();
  }

  return { data, extraEmails };
}

export default { gatherClockInContext, gatherClockOutContext };
