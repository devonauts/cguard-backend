/**
 * Add legal/important visit fields to the visitor logs table:
 *   idType, personVisited, company, vehiclePlate, phone
 *
 * Run: npx ts-node src/database/migrations/20260601-add-visitor-legal-fields.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  // Resolve the actual visitor-log table name (visitorLogs / visitorLog).
  const tables = await queryInterface.showAllTables();
  const table =
    (tables as string[]).find((t) => /^visitorlogs?$/i.test(t)) || 'visitorLogs';

  const columns: Record<string, any> = {
    idType: { type: DataTypes.STRING(50), allowNull: true },
    personVisited: { type: DataTypes.STRING(255), allowNull: true },
    company: { type: DataTypes.STRING(255), allowNull: true },
    vehiclePlate: { type: DataTypes.STRING(30), allowNull: true },
    vehicleType: { type: DataTypes.STRING(50), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    birthDate: { type: DataTypes.DATEONLY, allowNull: true },
    idExpiry: { type: DataTypes.DATEONLY, allowNull: true },
    tagNumber: { type: DataTypes.STRING(50), allowNull: true },
  };

  const desc = await queryInterface.describeTable(table);
  for (const [name, def] of Object.entries(columns)) {
    if (desc[name]) {
      console.log(`Column ${name} already exists on ${table}, skipping`);
      continue;
    }
    await queryInterface.addColumn(table, name, def);
    console.log(`Added ${name} to ${table}`);
  }

  console.log('✅ visitor legal fields migration complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
