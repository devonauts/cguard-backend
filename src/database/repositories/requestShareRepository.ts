import SequelizeRepository from './sequelizeRepository';
import { IRepositoryOptions } from './IRepositoryOptions';
import Sequelize, { Op } from 'sequelize';

export default class RequestShareRepository {
  static async create(data, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const record = await options.database.requestShare.create(
      {
        tenantId: data.tenantId,
        requestId: data.requestId,
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
    return options.database.requestShare.findOne({
      where: {
        token,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: now } },
        ],
      },
      include: ['tenant', 'request'],
      transaction,
    });
  }

  static async consume(token, options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const rec = await options.database.requestShare.findOne({ where: { token }, transaction });
    if (!rec) return null;
    await rec.destroy({ force: true, transaction });
    return rec;
  }

  static async deleteExpired(options: IRepositoryOptions) {
    const transaction = SequelizeRepository.getTransaction(options);
    const now = new Date();

    const result = await options.database.requestShare.destroy({
      where: {
        expiresAt: { [Op.lt]: now },
      },
      force: true,
      transaction,
    });

    return result;
  }
}
