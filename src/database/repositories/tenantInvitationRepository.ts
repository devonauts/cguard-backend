import SequelizeRepository from './sequelizeRepository';
import { IRepositoryOptions } from './IRepositoryOptions';
import Sequelize, { Op } from 'sequelize';

export default class TenantInvitationRepository {
  static async create(data, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const record = await options.database.tenantInvitation.create(
      {
        tenantId: data.tenantId,
        token: data.token,
        expiresAt: data.expiresAt || null,
      },
      { transaction },
    );

    return record;
  }

  static async findByToken(token, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const now = new Date();
    return options.database.tenantInvitation.findOne({
      where: {
        token,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: now } },
        ],
      },
      include: ['tenant'],
      transaction,
    });
  }

  static async consume(token, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const rec = await options.database.tenantInvitation.findOne({ where: { token }, transaction });
    if (!rec) return null;
    // Force a real delete for invitations to ensure they are removed permanently
    await rec.destroy({ force: true, transaction });
    return rec;
  }

  static async deleteExpired(options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const now = new Date();

    const result = await options.database.tenantInvitation.destroy({
      where: {
        expiresAt: { [Op.lt]: now },
      },
      force: true,
      transaction,
    });

    return result; // number of deleted rows
  }
}
