/**
 * Supervisor licenses/credentials — mirror of the guard license endpoints,
 * keyed on the supervisor's USER id (no securityGuard row). Uses the new
 * `supervisorLicense` model; front/back images are `file` rows scoped to that
 * table via FileRepository (same mechanism as guardLicense). `req` doubles as
 * the repository options object (has database/currentUser/currentTenant), the
 * same convention the guard services use.
 */
import lodash from 'lodash';
import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import FileRepository from '../../database/repositories/fileRepository';
import Error404 from '../../errors/Error404';

const FIELDS = ['licenseTypeId', 'customName', 'number', 'issueDate', 'expiryDate', 'importHash'];

async function withImages(db: any, record: any) {
  const p = record.get({ plain: true });
  p.frontImage = await FileRepository.fillDownloadUrl(await record.getFrontImage());
  p.backImage = await FileRepository.fillDownloadUrl(await record.getBackImage());
  return p;
}

/** GET /tenant/:tenantId/supervisors/:userId/licenses */
export const listSupervisorLicenses = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardRead);
    const db = req.database;
    const rows = await db.supervisorLicense.findAll({
      where: { tenantId: req.currentTenant.id, supervisorUserId: req.params.userId },
      include: [{ model: db.licenseType, as: 'licenseType' }, { model: db.user, as: 'createdBy' }],
      order: [['createdAt', 'DESC']],
    });
    const out: any[] = [];
    for (const r of rows) out.push(await withImages(db, r));
    await ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** POST /tenant/:tenantId/supervisors/:userId/licenses */
export const createSupervisorLicense = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardCreate);
    const db = req.database;
    const uid = req.currentUser?.id;
    const data = req.body || {};
    const record = await db.supervisorLicense.create({
      ...lodash.pick(data, FIELDS),
      supervisorUserId: req.params.userId,
      tenantId: req.currentTenant.id,
      createdById: uid,
      updatedById: uid,
    });
    const table = db.supervisorLicense.getTableName();
    await FileRepository.replaceRelationFiles({ belongsTo: table, belongsToColumn: 'frontImage', belongsToId: record.id }, data.frontImage, req);
    await FileRepository.replaceRelationFiles({ belongsTo: table, belongsToColumn: 'backImage', belongsToId: record.id }, data.backImage, req);
    const fresh = await db.supervisorLicense.findByPk(record.id, { include: [{ model: db.licenseType, as: 'licenseType' }] });
    await ApiResponseHandler.success(req, res, { data: await withImages(db, fresh) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** PUT /tenant/:tenantId/supervisors/:userId/licenses/:licenseId */
export const updateSupervisorLicense = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
    const db = req.database;
    const data = req.body || {};
    const record = await db.supervisorLicense.findOne({
      where: { id: req.params.licenseId, tenantId: req.currentTenant.id, supervisorUserId: req.params.userId },
    });
    if (!record) throw new Error404();
    await record.update({ ...lodash.pick(data, FIELDS), updatedById: req.currentUser?.id });
    const table = db.supervisorLicense.getTableName();
    if ('frontImage' in data) await FileRepository.replaceRelationFiles({ belongsTo: table, belongsToColumn: 'frontImage', belongsToId: record.id }, data.frontImage, req);
    if ('backImage' in data) await FileRepository.replaceRelationFiles({ belongsTo: table, belongsToColumn: 'backImage', belongsToId: record.id }, data.backImage, req);
    const fresh = await db.supervisorLicense.findByPk(record.id, { include: [{ model: db.licenseType, as: 'licenseType' }] });
    await ApiResponseHandler.success(req, res, { data: await withImages(db, fresh) });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

/** DELETE /tenant/:tenantId/supervisors/:userId/licenses/:licenseId */
export const destroySupervisorLicense = async (req: any, res: any) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.securityGuardEdit);
    const db = req.database;
    const record = await db.supervisorLicense.findOne({
      where: { id: req.params.licenseId, tenantId: req.currentTenant.id, supervisorUserId: req.params.userId },
    });
    if (!record) throw new Error404();
    await record.destroy();
    await ApiResponseHandler.success(req, res, true);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
