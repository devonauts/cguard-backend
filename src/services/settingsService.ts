import SequelizeRepository from '../database/repositories/sequelizeRepository';
import SettingsRepository from '../database/repositories/settingsRepository';

const DEFAULT_SETTINGS = {
  theme: 'default',
};

class SettingsService {

  static async findOrCreateDefault(options) {
    return SettingsRepository.findOrCreateDefault(
      DEFAULT_SETTINGS,
      options,
    );
  }

  static async save(data, options) {
    const transaction = await SequelizeRepository.createTransaction(
      options.database,
    );

    try {
      const settings = await SettingsRepository.save(
        data,
        {
          ...options,
          transaction,
        },
      );

      await SequelizeRepository.commitTransaction(
        transaction,
      );

      return settings;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }
}

export default SettingsService;
