import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import { Op } from 'sequelize';

/**
 * Aggregate read for the client "Contrato y servicios" subpage.
 *
 * Returns the contract terms (stored on clientAccount), the contracted-services
 * catalog with LIVE "utilizado" computed from real operations this month, the
 * renewal history, and a few derived headline numbers (días restantes, horas
 * utilizadas, cumplimiento de rondas). No billing amounts — the product is
 * purely operational.
 */
export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    await assertClientAccess(req, req.params.id);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;

    const database = req.database;
    const BusinessInfo = database.businessInfo;
    const Station = database.station;
    const GuardShift = database.guardShift;
    const SiteTourTag = database.siteTourTag;
    const VisitorLog = database.visitorLog;
    const VideoDevice = database.videoDevice;
    const Incident = database.incident;

    // Contract terms live on the clientAccount row.
    const client: any = await database.clientAccount.findByPk(clientAccountId);
    if (!client || (tenantId && client.tenantId && client.tenantId !== tenantId)) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }

    // Tenant timezone + "now" for month-window aggregation.
    let tenantTimezone: string | null = null;
    try {
      const tnt = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
      tenantTimezone = (tnt && tnt.timezone) || null;
    } catch { /* non-fatal */ }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Scope: this client's post sites and their stations.
    const postSites = await BusinessInfo.findAll({ where: { clientAccountId, tenantId }, attributes: ['id'] });
    const postSiteIds = (postSites || []).map((p: any) => p.id).filter(Boolean);
    const stations = postSiteIds.length
      ? await Station.findAll({ where: { postSiteId: postSiteIds, tenantId }, attributes: ['id'] })
      : [];
    const stationIds = (stations || []).map((s: any) => s.id).filter(Boolean);

    const sedesCount = postSiteIds.length;
    const stationsCount = stationIds.length;

    // ---- Live usage signals for the current month --------------------------
    const usage: Record<string, number | null> = {
      fixed_guard: stationsCount,
      access_control: null,
      camera_monitoring: null,
      mobile_patrol: null,
      visitor_management: null,
      alarm_response: null,
      asset_custody: null,
      event_security: null,
    };

    // Cameras registered under the client's sites.
    try {
      if (postSiteIds.length) {
        usage.camera_monitoring = await VideoDevice.count({
          where: { tenantId, postSiteId: postSiteIds },
        });
      }
    } catch { /* model/table optional */ }

    // Rounds (tour tag scans) completed this month.
    try {
      if (postSiteIds.length) {
        usage.mobile_patrol = await SiteTourTag.count({
          where: { tenantId, postSiteId: postSiteIds, createdAt: { [Op.gte]: monthStart } },
        });
      }
    } catch { /* non-fatal */ }

    // Visitors registered this month.
    try {
      if (postSiteIds.length || stationIds.length) {
        const orV: any[] = [];
        if (postSiteIds.length) orV.push({ postSiteId: postSiteIds });
        if (stationIds.length) orV.push({ stationId: stationIds });
        usage.visitor_management = await VisitorLog.count({
          where: { [Op.and]: [{ tenantId }, { [Op.or]: orV }, { createdAt: { [Op.gte]: monthStart } }] },
        });
      }
    } catch { /* non-fatal */ }

    // Incidents / alarm events this month.
    let incidentsThisMonth = 0;
    try {
      if (postSiteIds.length) {
        const tenantFilter: any = tenantId ? { [Op.or]: [{ tenantId }, { tenantId: null }] } : {};
        incidentsThisMonth = await Incident.count({
          where: { [Op.and]: [tenantFilter, { [Op.or]: [{ postSiteId: postSiteIds }, { siteId: postSiteIds }] }, { createdAt: { [Op.gte]: monthStart } }] },
        });
      }
    } catch { /* non-fatal */ }
    usage.alarm_response = incidentsThisMonth;

    // Guard-shift hours logged this month + distinct assigned guards.
    let hoursUsedSeconds = 0;
    const guardSet = new Set<string>();
    try {
      const orShift: any[] = [];
      if (postSiteIds.length) orShift.push({ postSiteId: postSiteIds });
      if (stationIds.length) orShift.push({ stationNameId: stationIds });
      if (orShift.length) {
        const shifts = await GuardShift.findAll({
          where: { [Op.and]: [{ tenantId }, { [Op.or]: orShift }, { punchInTime: { [Op.gte]: monthStart } }] },
          attributes: ['punchInTime', 'punchOutTime', 'guardNameId'],
        });
        for (const sh of (shifts || [])) {
          if (sh.guardNameId) guardSet.add(String(sh.guardNameId));
          const s = sh.punchInTime ? new Date(sh.punchInTime) : null;
          const e = sh.punchOutTime ? new Date(sh.punchOutTime) : now;
          if (s && e && e > s) hoursUsedSeconds += Math.floor((e.getTime() - s.getTime()) / 1000);
        }
      }
    } catch { /* non-fatal */ }
    const hoursUsed = Math.round(hoursUsedSeconds / 3600);

    // Rounds compliance % (scans done vs. contracted rounds target, if any).
    let roundsCompliance: number | null = null;

    // ---- Contracted-services catalog with live utilizado --------------------
    let services: any[] = [];
    try {
      const rows = await database.contractService.findAll({
        where: { tenantId, clientAccountId },
        order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
      });
      services = (rows || []).map((r: any) => {
        const p = typeof r.get === 'function' ? r.get({ plain: true }) : r;
        const used = Object.prototype.hasOwnProperty.call(usage, p.serviceKey) ? usage[p.serviceKey] : null;
        // Compliance: usADO / contratado when both known; null = "—".
        let compliance: number | null = null;
        if (p.contractedQty != null && p.contractedQty > 0 && used != null) {
          compliance = Math.min(100, Math.round((used / p.contractedQty) * 100));
        }
        if (p.serviceKey === 'mobile_patrol' && compliance != null) roundsCompliance = compliance;
        return { ...p, used, compliance };
      });
    } catch { services = []; }

    // ---- Renewal history ----------------------------------------------------
    let renewals: any[] = [];
    try {
      const rows = await database.contractRenewal.findAll({
        where: { tenantId, clientAccountId },
        order: [['fromDate', 'DESC'], ['createdAt', 'DESC']],
      });
      renewals = (rows || []).map((r: any) => (typeof r.get === 'function' ? r.get({ plain: true }) : r));
    } catch { renewals = []; }

    // ---- Derived headline numbers ------------------------------------------
    const endDate = client.contractEndDate ? new Date(`${client.contractEndDate}T00:00:00Z`) : null;
    let daysRemaining: number | null = null;
    if (endDate) {
      const today0 = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      daysRemaining = Math.round((endDate.getTime() - today0.getTime()) / (24 * 3600 * 1000));
    }
    let durationMonths: number | null = null;
    if (client.contractDate && client.contractEndDate) {
      const a = new Date(`${client.contractDate}T00:00:00Z`);
      const b = new Date(`${client.contractEndDate}T00:00:00Z`);
      durationMonths = Math.max(0, Math.round((b.getTime() - a.getTime()) / (30.4375 * 24 * 3600 * 1000)));
    }

    const contract = {
      id: client.id,
      name: client.name,
      code: client.code,
      active: client.active,
      contractNumber: client.contractNumber,
      contractType: client.contractType,
      currency: client.currency,
      paymentTerms: client.paymentTerms,
      contractDate: client.contractDate,
      contractEndDate: client.contractEndDate,
      autoRenew: client.autoRenew,
      autoRenewDaysBefore: client.autoRenewDaysBefore,
      penaltyClause: client.penaltyClause,
      earlyCancellationNotice: client.earlyCancellationNotice,
      jurisdiction: client.jurisdiction,
      contractedHoursPerMonth: client.contractedHoursPerMonth,
      contractNotes: client.contractNotes,
      slaUptimeTarget: client.slaUptimeTarget,
      slaResponseMinutes: client.slaResponseMinutes,
      slaRoundsTarget: client.slaRoundsTarget,
      slaReportsTarget: client.slaReportsTarget,
    };

    return ApiResponseHandler.success(req, res, {
      contract,
      services,
      renewals,
      usage,
      derived: {
        sedesCount,
        stationsCount,
        guardsCount: guardSet.size,
        hoursUsed,
        hoursContracted: client.contractedHoursPerMonth || null,
        daysRemaining,
        durationMonths,
        incidentsThisMonth,
        roundsCompliance,
        tenantTimezone,
      },
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
