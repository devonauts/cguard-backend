require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Detecting incidentTypes table name and ensuring `active` column exists...');

    const candidates = ['incidenttypes', 'incidentTypes'];
    let foundTable = null as string | null;

    for (const t of candidates) {
      try {
        await queryInterface.describeTable(t);
        foundTable = t;
        break;
      } catch (err) {
        // table does not exist, keep searching
      }
    }

    if (!foundTable) {
      console.warn('No incident types table found (checked incidenttypes and incidentTypes). Skipping.');
      process.exit(0);
    }

    console.log('Found table:', foundTable);

    const desc = await queryInterface.describeTable(foundTable);
    if (!desc['active']) {
      console.log('Adding `active` column to', foundTable);
      await queryInterface.addColumn(foundTable, 'active', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });

      // Ensure existing nulls are set to true
      await sequelize.query(`UPDATE \`${foundTable}\` SET active = true WHERE active IS NULL`);

      console.log('✅ `active` added to', foundTable);
    } else {
      console.log('`active` already exists on', foundTable);
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
