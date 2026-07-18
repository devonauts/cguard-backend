import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';

/**
 * Update ONLY the contract/SLA term columns on a clientAccount. Deliberately
 * does not go through the generic clientAccount update (which forces categoryIds
 * and lat/lng, wiping them on partial saves).
 */
const CONTRACT_FIELDS = [
  'contractNumber',
  'contractType',
  'currency',
  'paymentTerms',
  'contractDate',
  'contractEndDate',
  'autoRenew',
  'autoRenewDaysBefore',
  'penaltyClause',
  'earlyCancellationNotice',
  'jurisdiction',
  'contractedHoursPerMonth',
  'contractNotes',
  'slaUptimeTarget',
  'slaResponseMinutes',
  'slaRoundsTarget',
  'slaReportsTarget',
];

const INT_FIELDS = new Set([
  'autoRenewDaysBefore',
  'contractedHoursPerMonth',
  'slaUptimeTarget',
  'slaResponseMinutes',
  'slaRoundsTarget',
  'slaReportsTarget',
]);

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.clientAccountEdit);

    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const raw = req.body?.data || req.body || {};

    const client: any = await req.database.clientAccount.findByPk(clientAccountId);
    if (!client || (tenantId && client.tenantId && client.tenantId !== tenantId)) {
      return ApiResponseHandler.error(req, res, { code: 404 });
    }

    const patch: any = {};
    for (const f of CONTRACT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, f)) continue;
      let v = raw[f];
      if (v === '' || v === undefined) v = null;
      if (v !== null && INT_FIELDS.has(f)) {
        const n = parseInt(String(v), 10);
        v = Number.isFinite(n) ? n : null;
      }
      if (f === 'autoRenew') v = v === true || v === 'true' || v === 1 || v === '1';
      patch[f] = v;
    }

    await client.update(patch);

    return ApiResponseHandler.success(req, res, { id: client.id, ...patch });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
