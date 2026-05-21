require('dotenv').config();

import models from '../models';

/**
 * Migration: Convert position types from day/night/relief to fijo/sacafranco
 * 
 * Changes:
 * 1. Alter the ENUM column type in stationPositions from (day,night,relief) to STRING(20)
 * 2. Update existing records: day→fijo, night→fijo, relief→sacafranco
 * 3. Rename positions: Diurno→Fijo 1, Nocturno→Fijo 2, relief positions→Sacafranco
 */
async function migrate() {
  const { sequelize } = models();

  try {
    console.log('Starting migration: convert position types to fijo/sacafranco...');

    // 1. Change ENUM to VARCHAR(20) to allow new values
    // MySQL requires dropping the ENUM and recreating as VARCHAR
    await sequelize.query(`
      ALTER TABLE stationPositions 
      MODIFY COLUMN type VARCHAR(20) NOT NULL DEFAULT 'fijo'
    `);
    console.log('✓ Changed type column from ENUM to VARCHAR(20)');

    // 2. Update type values: day→fijo, night→fijo, relief→sacafranco
    const [dayUpdated] = await sequelize.query(`
      UPDATE stationPositions SET type = 'fijo' WHERE type = 'day'
    `);
    console.log(`✓ Updated day → fijo`);

    const [nightUpdated] = await sequelize.query(`
      UPDATE stationPositions SET type = 'fijo' WHERE type = 'night'
    `);
    console.log(`✓ Updated night → fijo`);

    const [reliefUpdated] = await sequelize.query(`
      UPDATE stationPositions SET type = 'sacafranco' WHERE type = 'relief'
    `);
    console.log(`✓ Updated relief → sacafranco`);

    // 3. Rename positions: Diurno→Fijo 1, Nocturno→Fijo 2
    await sequelize.query(`
      UPDATE stationPositions SET name = 'Fijo 1' WHERE name = 'Diurno' AND type = 'fijo'
    `);
    console.log('✓ Renamed Diurno → Fijo 1');

    await sequelize.query(`
      UPDATE stationPositions SET name = 'Fijo 2' WHERE name = 'Nocturno' AND type = 'fijo'
    `);
    console.log('✓ Renamed Nocturno → Fijo 2');

    await sequelize.query(`
      UPDATE stationPositions SET name = 'Fijo 1' WHERE name = 'Turno Principal' AND type = 'fijo'
    `);
    console.log('✓ Renamed Turno Principal → Fijo 1');

    // 4. For Fijo 2 positions (formerly Nocturno), update startTime/endTime to day shift times
    // Since Fijo positions now rotate D/N, they use day-shift start as base (07:00-19:00)
    await sequelize.query(`
      UPDATE stationPositions 
      SET startTime = '07:00', endTime = '19:00' 
      WHERE name = 'Fijo 2' AND type = 'fijo' AND startTime = '19:00'
    `);
    console.log('✓ Updated Fijo 2 time windows to 07:00-19:00 (rotates D/N)');

    // 5. Add 3-3-1 rotation if not exists (common pattern from Excel)
    const [[exists331]] = await sequelize.query(`
      SELECT id FROM rotationStyles WHERE name = '3-3-1' LIMIT 1
    `);
    if (!exists331) {
      await sequelize.query(`
        INSERT INTO rotationStyles (id, name, description, dayShifts, nightShifts, restDays, isSystem, tenantId, createdAt, updatedAt)
        VALUES (UUID(), '3-3-1', '3 días, 3 noches, 1 descanso', 3, 3, 1, 1, NULL, NOW(), NOW())
      `);
      console.log('✓ Added 3-3-1 rotation style');
    }

    console.log('\n✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
