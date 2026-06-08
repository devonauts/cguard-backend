/**
 * GET /tenant/:tenantId/alarm/case/:id/cameras
 * Cameras to verify an alarm case: cameras linked to the zones in the case's
 * events (alarmZone.linkedCameraId), falling back to the cameras at the panel's
 * post-site/station. Returns videoCamera records (consumed by the video player).
 * Tenant-scoped; businessInfoRead.
 */
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error404 from '../../errors/Error404';

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.businessInfoRead);
    const db = req.database;
    const tenantId = req.currentTenant.id;

    const c = await db.alarmCase.findOne({ where: { id: req.params.id, tenantId } });
    if (!c) throw new Error404();

    // (1) cameras linked to the zones that fired in this case.
    const events = await db.alarmEvent.findAll({ where: { alarmCaseId: c.id, tenantId }, attributes: ['alarmZoneId'] });
    const zoneIds = Array.from(new Set((events || []).map((e: any) => e.alarmZoneId).filter(Boolean)));
    let cameraIds: string[] = [];
    if (zoneIds.length) {
      const zones = await db.alarmZone.findAll({ where: { id: zoneIds, tenantId }, attributes: ['linkedCameraId'] });
      cameraIds = Array.from(new Set((zones || []).map((z: any) => z.linkedCameraId).filter(Boolean)));
    }

    // (2) fallback: cameras at the panel's station/post-site.
    if (!cameraIds.length) {
      const panel = await db.alarmPanel.findByPk(c.alarmPanelId);
      if (panel && (panel.stationId || panel.postSiteId)) {
        const where: any = { tenantId };
        if (panel.stationId) where.stationId = panel.stationId;
        else where.postSiteId = panel.postSiteId;
        const cams = await db.videoCamera.findAll({ where, limit: 8 });
        cameraIds = (cams || []).map((x: any) => x.id);
      }
    }

    const cameras = cameraIds.length
      ? await db.videoCamera.findAll({
          where: { id: cameraIds, tenantId },
          include: [{ model: db.videoDevice, as: 'device', required: false }],
        })
      : [];

    await ApiResponseHandler.success(req, res, (cameras || []).map((x: any) => (typeof x.get === 'function' ? x.get({ plain: true }) : x)));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
