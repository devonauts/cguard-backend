/**
 * Create the alarm monitoring (central station) tables: alarmPanels,
 * alarmZones, alarmSignals, alarmEvents, alarmCases, actionPlans,
 * alarmContacts, alarmDispatches, alarmAuditLogs, openCloseSchedules.
 * Idempotent — each table is created only if it does not already exist
 * (guarded by describeTable / try-catch).
 *
 * Run: npx ts-node src/database/migrations/20260608-create-alarm-monitoring.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function tableExists(qi: QueryInterface, table: string): Promise<boolean> {
  try {
    await qi.describeTable(table);
    return true;
  } catch (e) {
    return false;
  }
}

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const timestampCols = {
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  };

  // ---- alarmPanels ----
  if (await tableExists(qi, 'alarmPanels')) {
    console.log('alarmPanels already exists, skipping');
  } else {
    await qi.createTable('alarmPanels', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      accountNumber: { type: DataTypes.STRING(40), allowNull: true },
      protocol: { type: DataTypes.STRING(20), defaultValue: 'sia-dc09' },
      panelType: { type: DataTypes.STRING(20), defaultValue: 'intrusion' },
      make: { type: DataTypes.STRING(80), allowNull: true },
      model: { type: DataTypes.STRING(80), allowNull: true },
      comms: { type: DataTypes.STRING(20), defaultValue: 'ip' },
      receiverLine: { type: DataTypes.STRING(40), allowNull: true },
      dc09Key: { type: DataTypes.STRING(255), allowNull: true },
      supervisionMins: { type: DataTypes.INTEGER, defaultValue: 0 },
      testIntervalHrs: { type: DataTypes.INTEGER, allowNull: true },
      status: { type: DataTypes.STRING(20), defaultValue: 'unknown' },
      lastSignalAt: { type: DataTypes.DATE, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      customerId: { type: DataTypes.UUID, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, defaultValue: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmPanels');
  }

  // ---- alarmZones ----
  if (await tableExists(qi, 'alarmZones')) {
    console.log('alarmZones already exists, skipping');
  } else {
    await qi.createTable('alarmZones', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      zoneNumber: { type: DataTypes.STRING(20), allowNull: true },
      name: { type: DataTypes.STRING(160), allowNull: true },
      type: { type: DataTypes.STRING(20), defaultValue: 'motion' },
      partition: { type: DataTypes.STRING(10), allowNull: true },
      linkedCameraId: { type: DataTypes.UUID, allowNull: true },
      bypassed: { type: DataTypes.BOOLEAN, defaultValue: false },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmZones');
  }

  // ---- alarmSignals ----
  if (await tableExists(qi, 'alarmSignals')) {
    console.log('alarmSignals already exists, skipping');
  } else {
    await qi.createTable('alarmSignals', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      accountNumber: { type: DataTypes.STRING(40), allowNull: true },
      zoneNumber: { type: DataTypes.STRING(20), allowNull: true },
      partition: { type: DataTypes.STRING(10), allowNull: true },
      format: { type: DataTypes.STRING(20), allowNull: true },
      eventCode: { type: DataTypes.STRING(20), allowNull: true },
      qualifier: { type: DataTypes.STRING(10), allowNull: true },
      raw: { type: DataTypes.TEXT, allowNull: true },
      channel: { type: DataTypes.STRING(20), allowNull: true },
      receiverId: { type: DataTypes.STRING(40), allowNull: true },
      receivedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmSignals');
  }

  // ---- alarmEvents ----
  if (await tableExists(qi, 'alarmEvents')) {
    console.log('alarmEvents already exists, skipping');
  } else {
    await qi.createTable('alarmEvents', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmSignalId: { type: DataTypes.UUID, allowNull: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      alarmZoneId: { type: DataTypes.UUID, allowNull: true },
      category: { type: DataTypes.STRING(20), allowNull: true },
      priority: { type: DataTypes.INTEGER, defaultValue: 3 },
      description: { type: DataTypes.STRING(255), allowNull: true },
      zoneNumber: { type: DataTypes.STRING(20), allowNull: true },
      at: { type: DataTypes.DATE, allowNull: true },
      alarmCaseId: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmEvents');
  }

  // ---- alarmCases ----
  if (await tableExists(qi, 'alarmCases')) {
    console.log('alarmCases already exists, skipping');
  } else {
    await qi.createTable('alarmCases', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.STRING(16), defaultValue: 'queued' },
      priority: { type: DataTypes.INTEGER, defaultValue: 3 },
      category: { type: DataTypes.STRING(20), allowNull: true },
      title: { type: DataTypes.STRING(200), allowNull: true },
      assignedOperatorId: { type: DataTypes.UUID, allowNull: true },
      ackAt: { type: DataTypes.DATE, allowNull: true },
      dispatchAt: { type: DataTypes.DATE, allowNull: true },
      resolvedAt: { type: DataTypes.DATE, allowNull: true },
      closedAt: { type: DataTypes.DATE, allowNull: true },
      disposition: { type: DataTypes.STRING(16), allowNull: true },
      incidentId: { type: DataTypes.UUID, allowNull: true },
      dispatchId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      customerId: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmCases');
  }

  // ---- actionPlans ----
  if (await tableExists(qi, 'actionPlans')) {
    console.log('actionPlans already exists, skipping');
  } else {
    await qi.createTable('actionPlans', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      appliesToCategory: { type: DataTypes.STRING(20), allowNull: true },
      steps: { type: DataTypes.JSON, allowNull: true },
      active: { type: DataTypes.BOOLEAN, defaultValue: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created actionPlans');
  }

  // ---- alarmContacts ----
  if (await tableExists(qi, 'alarmContacts')) {
    console.log('alarmContacts already exists, skipping');
  } else {
    await qi.createTable('alarmContacts', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(160), allowNull: true },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      email: { type: DataTypes.STRING(160), allowNull: true },
      callOrder: { type: DataTypes.INTEGER, defaultValue: 1 },
      passcode: { type: DataTypes.STRING(40), allowNull: true },
      authority: { type: DataTypes.STRING(20), allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmContacts');
  }

  // ---- alarmDispatches ----
  if (await tableExists(qi, 'alarmDispatches')) {
    console.log('alarmDispatches already exists, skipping');
  } else {
    await qi.createTable('alarmDispatches', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmCaseId: { type: DataTypes.UUID, allowNull: true },
      type: { type: DataTypes.STRING(20), allowNull: true },
      target: { type: DataTypes.STRING(160), allowNull: true },
      status: { type: DataTypes.STRING(16), defaultValue: 'requested' },
      eta: { type: DataTypes.DATE, allowNull: true },
      outcome: { type: DataTypes.TEXT, allowNull: true },
      dispatchedById: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmDispatches');
  }

  // ---- alarmAuditLogs ----
  if (await tableExists(qi, 'alarmAuditLogs')) {
    console.log('alarmAuditLogs already exists, skipping');
  } else {
    await qi.createTable('alarmAuditLogs', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmCaseId: { type: DataTypes.UUID, allowNull: true },
      action: { type: DataTypes.STRING(60), allowNull: true },
      detail: { type: DataTypes.TEXT, allowNull: true },
      actorId: { type: DataTypes.UUID, allowNull: true },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created alarmAuditLogs');
  }

  // ---- openCloseSchedules ----
  if (await tableExists(qi, 'openCloseSchedules')) {
    console.log('openCloseSchedules already exists, skipping');
  } else {
    await qi.createTable('openCloseSchedules', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      alarmPanelId: { type: DataTypes.UUID, allowNull: true },
      dayOfWeek: { type: DataTypes.INTEGER, allowNull: true },
      openTime: { type: DataTypes.STRING(5), allowNull: true },
      closeTime: { type: DataTypes.STRING(5), allowNull: true },
      graceMins: { type: DataTypes.INTEGER, defaultValue: 15 },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created openCloseSchedules');
  }

  console.log('Alarm monitoring migration complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
