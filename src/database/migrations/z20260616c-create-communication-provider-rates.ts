require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Foundation (unified communications): create communicationProviderRates and
 * seed sensible default rates (sms ~5c, whatsapp utility ~1c, push 0, email 0).
 * Idempotent — table create is guarded, seeds are insert-if-absent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'communicationProviderRates' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      console.log('Creating communicationProviderRates table...');
      await qi.createTable('communicationProviderRates', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        provider: { type: DataTypes.STRING(32), allowNull: false },
        channel: { type: DataTypes.STRING(16), allowNull: false },
        countryCode: { type: DataTypes.STRING(8), allowNull: true },
        messageType: { type: DataTypes.STRING(32), allowNull: true },
        costCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        markupPercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
        currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      });
      // Explicit short name: MySQL caps identifiers at 64 chars and the
      // auto-generated name for these 4 columns exceeds it.
      await qi.addIndex('communicationProviderRates', ['provider', 'channel', 'countryCode', 'messageType'], {
        name: 'cpr_provider_channel_country_type',
      });
      console.log('✅ communicationProviderRates created.');
    } else {
      console.log('Table communicationProviderRates already exists. Skipping create.');
    }

    // Default rates — wildcard (NULL country/messageType). Markup 0 by default.
    const defaults = [
      { provider: 'firebase', channel: 'push', cost: 0, markup: 0 },
      { provider: 'smtp', channel: 'email', cost: 0, markup: 0 },
      { provider: 'twilio', channel: 'sms', cost: 5, markup: 0 },
      { provider: 'meta', channel: 'whatsapp', cost: 1, markup: 0 },
    ];

    for (const d of defaults) {
      const [rows]: any = await sequelize.query(
        `SELECT id FROM communicationProviderRates
         WHERE provider = :provider AND channel = :channel
           AND countryCode IS NULL AND messageType IS NULL`,
        { replacements: { provider: d.provider, channel: d.channel } },
      );
      if (rows && rows.length) continue;
      await sequelize.query(
        `INSERT INTO communicationProviderRates
           (id, provider, channel, countryCode, messageType, costCents, markupPercentage, currency, active, createdAt, updatedAt)
         VALUES (UUID(), :provider, :channel, NULL, NULL, :cost, :markup, 'USD', 1, NOW(), NOW())`,
        { replacements: { provider: d.provider, channel: d.channel, cost: d.cost, markup: d.markup } },
      );
      console.log(`  seeded rate: ${d.provider}/${d.channel} = ${d.cost}c`);
    }

    console.log('✅ communicationProviderRates seeded.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
