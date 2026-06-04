/**
 * Consigna phase 2: add notify settings to stationOrders + create the
 * stationOrderCompletions activity-log table.
 * Run: npx ts-node scripts/20260604-consigna-notify-and-completions.ts
 */
require('dotenv').config();

import models from '../src/database/models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const find = (re: RegExp, fb: string) => (tables as string[]).find((t) => re.test(t)) || fb;

  // 1) new columns on stationOrders
  const ordersTbl = find(/^stationorders?$/i, 'stationOrders');
  const desc = await qi.describeTable(ordersTbl);
  const add = async (name: string, def: any) => {
    if (desc[name]) console.log(`  ${name} exists, skip`);
    else { await qi.addColumn(ordersTbl, name, def); console.log(`  + ${name}`); }
  };
  await add('notifyEnabled', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
  await add('notifyMinutesBefore', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await add('lastNotifiedAt', { type: DataTypes.DATE, allowNull: true });

  // 2) completions table
  if ((tables as string[]).some((t) => /^stationordercompletions?$/i.test(t))) {
    console.log('stationOrderCompletions already exists, skip');
  } else {
    await qi.createTable('stationOrderCompletions', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      occurrenceDate: { type: DataTypes.DATEONLY, allowNull: false },
      completedAt: { type: DataTypes.DATE, allowNull: false },
      note: { type: DataTypes.TEXT, allowNull: true },
      photos: { type: DataTypes.TEXT, allowNull: true },
      videoUrl: { type: DataTypes.TEXT, allowNull: true },
      audioUrl: { type: DataTypes.TEXT, allowNull: true },
      guardName: { type: DataTypes.STRING(255), allowNull: true },
      stationOrderId: { type: DataTypes.UUID, allowNull: false },
      stationId: { type: DataTypes.UUID, allowNull: true },
      securityGuardId: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
    });
    await qi.addIndex('stationOrderCompletions', ['tenantId', 'stationOrderId', 'occurrenceDate'], { name: 'soc_order_occurrence' });
    console.log('  + stationOrderCompletions table');
  }
  console.log('✅ consigna notify + completions migration complete');
  process.exit(0);
}
migrate().catch((e) => { console.error(e); process.exit(1); });
