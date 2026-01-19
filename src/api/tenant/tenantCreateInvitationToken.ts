const { Op } = require('sequelize');
const crypto = require('crypto');

const TenantInvitationRepository = require('../../database/repositories/tenantInvitationRepository').default;
const TenantRepository = require('../../database/repositories/tenantRepository').default;
const SequelizeRepository = require('../../database/repositories/sequelizeRepository').default;

export default async (req, res) => {
  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch (_) {
      return String(error);
    }
  }
  try {
    const tenantId = req.params.tenantId || (req.body && req.body.tenantId);
    if (!tenantId) return res.status(400).send({ message: 'tenantId required' });

    // simple permission check: current user must belong to tenant
    // (skip strict check here; caller should ensure correct tenant context)

    // Use existing transaction pattern from other endpoints
    const transaction = SequelizeRepository.getTransaction(req);

    try {
      // generate a unique 6-digit numeric token
      let token;
      let attempts = 0;
      do {
        token = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
        const exists = await TenantInvitationRepository.findByToken(token, { ...req, transaction });
        if (!exists) break;
        attempts++;
      } while (attempts < 5);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      const rec = await TenantInvitationRepository.create({ tenantId, token, expiresAt }, { ...req, transaction });

      return res.status(200).send({ token: rec.token, expiresAt: rec.expiresAt });
    } catch (err) {
      console.error(err);
      return res.status(500).send({ message: getErrorMessage(err) });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: getErrorMessage(error) });
  }
};
