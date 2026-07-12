import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import {
  getAccount,
  provisionSubaccount,
  listTransactions,
  listAvailableNumbers,
  buyNumber,
} from '../../services/smsAccountService';

/**
 * Per-tenant SMS account: Twilio subaccount + number management.
 *   GET    /tenant/:tenantId/sms-account              → status + recent ledger
 *   POST   /tenant/:tenantId/sms-account/provision    → create the Twilio subaccount
 *   GET    /tenant/:tenantId/sms-account/transactions → full ledger
 *
 * NOTE: the legacy POST /sms-account/recharge endpoint was RETIRED — the
 * tenantSmsAccount prepaid balance was migrated into the unified
 * communicationWallets (migration z20260713b) and all SMS billing now debits
 * that single wallet. Top-ups go through POST /communications/wallet/recharge
 * (purpose 'communications_recharge'). Number management stays here.
 */
export default (app) => {
  app.get('/tenant/:tenantId/sms-account', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const account = await getAccount(db, tenantId);
      const transactions = await listTransactions(db, tenantId, 20);
      return ApiResponseHandler.success(req, res, { account, transactions });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/sms-account/transactions', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsRead);
      const db = req.database;
      const tenantId = req.currentTenant.id;
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const transactions = await listTransactions(db, tenantId, limit);
      return ApiResponseHandler.success(req, res, { transactions });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/sms-account/provision', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const account = await provisionSubaccount(db, req.currentTenant);
      return ApiResponseHandler.success(req, res, { account });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/sms-account/available-numbers', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const numbers = await listAvailableNumbers(db, req.currentTenant, {
        country: req.query.country,
        areaCode: req.query.areaCode,
        contains: req.query.contains,
        limit: req.query.limit,
      });
      return ApiResponseHandler.success(req, res, { numbers });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

  app.post('/tenant/:tenantId/sms-account/buy-number', async (req, res) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.settingsEdit);
      const db = req.database;
      const data = (req.body && req.body.data) || req.body || {};
      const account = await buyNumber(db, req.currentTenant, {
        phoneNumber: data.phoneNumber,
        country: data.country,
        areaCode: data.areaCode,
      });
      return ApiResponseHandler.success(req, res, { account });
    } catch (error) {
      return ApiResponseHandler.error(req, res, error);
    }
  });

};
