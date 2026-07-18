import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

const SERVICE_FIELDS = ['serviceKey', 'name', 'description', 'unit', 'contractedQty', 'slaTarget', 'sortOrder', 'active'];
const INT_FIELDS = new Set(['contractedQty', 'slaTarget', 'sortOrder']);

function pickServiceData(raw: any) {
  const out: any = {};
  for (const f of SERVICE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, f)) continue;
    let v = raw[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null && INT_FIELDS.has(f)) {
      const n = parseInt(String(v), 10);
      v = Number.isFinite(n) ? n : null;
    }
    if (f === 'active') v = !(v === false || v === 'false' || v === 0 || v === '0');
    out[f] = v;
  }
  return out;
}

export const create = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const raw = req.body?.data || req.body || {};

    const data = pickServiceData(raw);
    if (!data.name) return ApiResponseHandler.error(req, res, { code: 400, message: 'name required' });

    const created = await req.database.contractService.create({
      ...data,
      serviceKey: data.serviceKey || 'custom',
      active: data.active === undefined ? true : data.active,
      tenantId,
      clientAccountId,
      createdById: req.currentUser?.id || null,
      updatedById: req.currentUser?.id || null,
    });

    return ApiResponseHandler.success(req, res, created.get({ plain: true }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const update = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const { serviceId } = req.params;
    const raw = req.body?.data || req.body || {};

    const row: any = await req.database.contractService.findByPk(serviceId);
    if (!row || row.tenantId !== tenantId || row.clientAccountId !== clientAccountId) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }

    await row.update({ ...pickServiceData(raw), updatedById: req.currentUser?.id || null });
    return ApiResponseHandler.success(req, res, row.get({ plain: true }));
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

export const destroy = async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const { serviceId } = req.params;

    const row: any = await req.database.contractService.findByPk(serviceId);
    if (!row || row.tenantId !== tenantId || row.clientAccountId !== clientAccountId) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }
    await row.destroy();
    return ApiResponseHandler.success(req, res, { id: serviceId, deleted: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
