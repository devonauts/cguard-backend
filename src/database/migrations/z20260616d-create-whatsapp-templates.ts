require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Foundation (unified communications): create whatsappTemplates and seed the 9
 * default global templates (tenantId NULL). Idempotent — create guarded, seeds
 * insert-if-absent keyed by (tenantId NULL, name, languageCode).
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'whatsappTemplates' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      console.log('Creating whatsappTemplates table...');
      await qi.createTable('whatsappTemplates', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: { type: DataTypes.UUID, allowNull: true },
        name: { type: DataTypes.STRING(128), allowNull: false },
        languageCode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'es' },
        category: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UTILITY' },
        bodyParamsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
        updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      });
      await qi.addIndex('whatsappTemplates', ['tenantId', 'name', 'languageCode']);
      console.log('✅ whatsappTemplates created.');
    } else {
      console.log('Table whatsappTemplates already exists. Skipping create.');
    }

    // The 9 default global templates. bodyParamsCount = number of {{n}} body vars.
    const seeds = [
      { name: 'otp_code', category: 'AUTHENTICATION', params: 1 },
      { name: 'shift_reminder', category: 'UTILITY', params: 3 },
      { name: 'new_assignment', category: 'UTILITY', params: 3 },
      { name: 'incident_alert', category: 'UTILITY', params: 4 },
      { name: 'missed_checkpoint', category: 'UTILITY', params: 3 },
      { name: 'no_show_alert', category: 'UTILITY', params: 3 },
      { name: 'visitor_arrived', category: 'UTILITY', params: 3 },
      { name: 'task_assigned', category: 'UTILITY', params: 2 },
      { name: 'panic_alert', category: 'UTILITY', params: 3 },
    ];

    for (const s of seeds) {
      const [rows]: any = await sequelize.query(
        `SELECT id FROM whatsappTemplates
         WHERE tenantId IS NULL AND name = :name AND languageCode = 'es'`,
        { replacements: { name: s.name } },
      );
      if (rows && rows.length) continue;
      await sequelize.query(
        `INSERT INTO whatsappTemplates
           (id, tenantId, name, languageCode, category, bodyParamsCount, active, createdAt, updatedAt)
         VALUES (UUID(), NULL, :name, 'es', :category, :params, 1, NOW(), NOW())`,
        { replacements: { name: s.name, category: s.category, params: s.params } },
      );
      console.log(`  seeded template: ${s.name} (${s.category}, ${s.params} params)`);
    }

    console.log('✅ whatsappTemplates seeded.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
