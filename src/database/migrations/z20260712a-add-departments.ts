/**
 * Departamentos (Settings › Departamentos): the tenant's internal org
 * structure. Creates the `departments` table and adds
 * `tenantUsers.departmentId` (one department per member, nullable).
 * The old Settings page was a non-functional stub; this backs the real CRUD.
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712a-add-departments.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  if (!tables.map((t: any) => String(t).toLowerCase()).includes('departments')) {
    await qi.createTable('departments', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      managerId: { type: DataTypes.UUID, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('departments', ['tenantId', 'name']);
    await qi.addIndex('departments', ['tenantId', 'active']);
    console.log('✅ departments table created');
  } else {
    console.log('↷ departments table already exists');
  }

  const tu: any = await qi.describeTable('tenantUsers');
  if (!tu.departmentId) {
    await qi.addColumn('tenantUsers', 'departmentId', {
      type: DataTypes.UUID,
      allowNull: true,
    });
    await qi.addIndex('tenantUsers', ['departmentId']);
    console.log('✅ tenantUsers.departmentId added');
  } else {
    console.log('↷ tenantUsers.departmentId already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
