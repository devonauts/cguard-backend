require('dotenv').config();

import models from '../models';
import { Op } from 'sequelize';

async function migrate() {
  const db = models();

  try {
    console.log('Starting seed: stations and shifts (idempotent)');

    // Ensure tables exist
    const [[stationsTable]] = await db.sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'stations' AND TABLE_SCHEMA = DATABASE()`
    );
    const [[shiftsTable]] = await db.sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'shifts' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!stationsTable || !shiftsTable) {
      console.log('One or both tables (stations/shifts) do not exist. Aborting seed.');
      process.exit(0);
    }

    // Find a tenant to attach records to (prefer seeded admin tenant)
    let tenant = await db.tenant.findOne({ where: { name: 'Empresa Admin' } });
    if (!tenant) {
      tenant = await db.tenant.findOne();
    }
    if (!tenant) {
      console.log('No tenant found to attach stations/shifts to. Aborting.');
      process.exit(0);
    }

    // Find an admin user to use as createdBy/guard
    let adminUser = await db.user.findOne({ where: { email: 'admin@cguard.com' } });
    if (!adminUser) {
      adminUser = await db.user.findOne();
    }

    // Seed stations if empty
    const stationsCount = await db.station.count();
    if (stationsCount === 0) {
      console.log('Seeding stations...');
      const s1 = await db.station.create({
        stationName: 'Estación Central',
        latitud: '0.0000',
        longitud: '0.0000',
        stationSchedule: '8 horas',
        tenantId: tenant.id,
        createdById: adminUser ? adminUser.id : null,
      });

      const s2 = await db.station.create({
        stationName: 'Estación Norte',
        latitud: '1.0000',
        longitud: '1.0000',
        stationSchedule: '8 horas',
        tenantId: tenant.id,
        createdById: adminUser ? adminUser.id : null,
      });

      console.log('Created stations:', s1.id, s2.id);
    } else {
      console.log('stations table not empty (count=', stationsCount, '), skipping seeding stations');
    }

    // Seed shifts if empty
    const shiftsCount = await db.shift.count();
    if (shiftsCount === 0) {
      console.log('Seeding shifts...');
      const station = await db.station.findOne({ where: { tenantId: tenant.id } });
      if (!station) {
        console.log('No station found for tenant, skipping shifts.');
      } else {
        const now = new Date();
        const later = new Date(now.getTime() + 8 * 60 * 60 * 1000); // +8 hours

        const sh1 = await db.shift.create({
          startTime: now,
          endTime: later,
          stationId: station.id,
          guardId: adminUser ? adminUser.id : null,
          tenantId: tenant.id,
          createdById: adminUser ? adminUser.id : null,
        });

        console.log('Created shift:', sh1.id);
      }
    } else {
      console.log('shifts table not empty (count=', shiftsCount, '), skipping seeding shifts');
    }

    console.log('✅ Seed completed.');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', (err as any) && (err as any).message ? (err as any).message : String(err));
    process.exit(1);
  }
}

migrate();
