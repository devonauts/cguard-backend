require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Quality-control / worker-reviews wiring:
 *   1. performanceSettings.weightClientRating — per-tenant weight for the new
 *      "client star reviews" factor in the guard performance score.
 *   2. memos.type ('memo' | 'observacion') — lets staff file a lighter internal
 *      observation vs a formal memo when acting on a review.
 *   3. memos.guardRatingId — origin review a memo/observación was generated from.
 *
 * Idempotent: each column is added only if missing.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  const addIfMissing = async (table: string, column: string, spec: any) => {
    let cols: any = {};
    try { cols = await queryInterface.describeTable(table); } catch { cols = {}; }
    if (cols[column]) {
      console.log(`${table}.${column} already exists, skipping`);
      return;
    }
    await queryInterface.addColumn(table, column, spec);
    console.log(`✅ ${table}.${column} added`);
  };

  try {
    await addIfMissing('performanceSettings', 'weightClientRating', {
      type: DataTypes.FLOAT, allowNull: true,
    });
    await addIfMissing('memos', 'type', {
      type: DataTypes.STRING(20), allowNull: false, defaultValue: 'memo',
    });
    await addIfMissing('memos', 'guardRatingId', {
      type: DataTypes.UUID, allowNull: true,
    });

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
