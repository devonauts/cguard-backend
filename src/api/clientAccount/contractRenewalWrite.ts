import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

const RENEWAL_FIELDS = ['periodLabel', 'fromDate', 'toDate', 'durationMonths', 'status'];
const INT_FIELDS = new Set(['durationMonths']);

function pickRenewalData(raw: any) {
  const out: any = {};
  for (const f of RENEWAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, f)) continue;
    let v = raw[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null && INT_FIELDS.has(f)) {
      const n = parseInt(String(v), 10);
      v = Number.isFinite(n) ? n : null;
    }
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

    const created = await req.database.contractRenewal.create({
      ...pickRenewalData(raw),
      status: (raw.status || 'active'),
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
    const { renewalId } = req.params;
    const raw = req.body?.data || req.body || {};

    const row: any = await req.database.contractRenewal.findByPk(renewalId);
    if (!row || row.tenantId !== tenantId || row.clientAccountId !== clientAccountId) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }
    await row.update({ ...pickRenewalData(raw), updatedById: req.currentUser?.id || null });
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
    const { renewalId } = req.params;

    const row: any = await req.database.contractRenewal.findByPk(renewalId);
    if (!row || row.tenantId !== tenantId || row.clientAccountId !== clientAccountId) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }
    await row.destroy();
    return ApiResponseHandler.success(req, res, { id: renewalId, deleted: true });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
