require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding request-like fields to incidents table...');

    const tableDesc = await queryInterface.describeTable('incidents');

    const cols: Array<{ name: string; def: any }> = [
      { name: 'dateTime', def: { type: DataTypes.DATE, allowNull: true } },
      { name: 'incidentAt', def: { type: DataTypes.DATE, allowNull: true } },
      { name: 'clientId', def: { type: DataTypes.UUID, allowNull: true } },
      { name: 'siteId', def: { type: DataTypes.UUID, allowNull: true } },
      { name: 'stationId', def: { type: DataTypes.UUID, allowNull: true } },
      { name: 'priority', def: { type: DataTypes.STRING(50), allowNull: true } },
      { name: 'internalNotes', def: { type: DataTypes.TEXT, allowNull: true } },
      { name: 'actionsTaken', def: { type: DataTypes.TEXT, allowNull: true } },
      { name: 'location', def: { type: DataTypes.TEXT, allowNull: true } },
      { name: 'subject', def: { type: DataTypes.STRING(200), allowNull: true } },
      { name: 'content', def: { type: DataTypes.TEXT, allowNull: true } },
      { name: 'action', def: { type: DataTypes.TEXT, allowNull: true } },
      { name: 'comments', def: { type: DataTypes.JSON, allowNull: true, defaultValue: [] } },
      { name: 'guardNameId', def: { type: DataTypes.UUID, allowNull: true } },
    ];

    for (const c of cols) {
      if (!tableDesc[c.name]) {
        await queryInterface.addColumn('incidents', c.name, c.def);
        console.log(`Added column ${c.name} to incidents`);
      } else {
        console.log(`Column ${c.name} already exists, skipping`);
      }
    }

    console.log('✅ Migration complete');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
