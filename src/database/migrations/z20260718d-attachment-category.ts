require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add a `category` column to `attachments` so the client "Documentos" library
 * can group documents (Post Orders, Manuales, Contratos, Reportes, …). Idempotent.
 * Run: npx ts-node src/database/migrations/z20260718d-attachment-category.ts
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  try {
    const [rows]: any = await sequelize.query(
      `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attachments' AND COLUMN_NAME = 'category'`,
    );
    if (rows && rows[0] && Number(rows[0].c) > 0) {
      console.log('attachments.category already exists, skipping.');
    } else {
      await qi.addColumn('attachments', 'category', { type: DataTypes.STRING(60), allowNull: true });
      console.log('✅ attachments.category added');
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };
migrate();
