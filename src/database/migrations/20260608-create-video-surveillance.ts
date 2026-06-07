/**
 * Create the video surveillance tables: videoDevices, videoCameras,
 * videoEvents, videoClips. Idempotent — each table is created only if it
 * does not already exist (guarded by describeTable / try-catch).
 *
 * Run: npx ts-node src/database/migrations/20260608-create-video-surveillance.ts
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

  // ---- videoDevices ----
  if (await tableExists(qi, 'videoDevices')) {
    console.log('videoDevices already exists, skipping');
  } else {
    await qi.createTable('videoDevices', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(160), allowNull: false },
      type: { type: DataTypes.STRING(20), defaultValue: 'dvr' },
      brand: { type: DataTypes.STRING(80), allowNull: true },
      model: { type: DataTypes.STRING(80), allowNull: true },
      host: { type: DataTypes.STRING(160), allowNull: true },
      port: { type: DataTypes.INTEGER, defaultValue: 554 },
      httpPort: { type: DataTypes.INTEGER, defaultValue: 80 },
      username: { type: DataTypes.STRING(120), allowNull: true },
      password: { type: DataTypes.STRING(255), allowNull: true },
      channels: { type: DataTypes.INTEGER, defaultValue: 1 },
      protocol: { type: DataTypes.STRING(20), defaultValue: 'rtsp' },
      status: { type: DataTypes.STRING(20), defaultValue: 'unknown' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      active: { type: DataTypes.BOOLEAN, defaultValue: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      updatedById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created videoDevices');
  }

  // ---- videoCameras ----
  if (await tableExists(qi, 'videoCameras')) {
    console.log('videoCameras already exists, skipping');
  } else {
    await qi.createTable('videoCameras', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      videoDeviceId: { type: DataTypes.UUID, allowNull: true },
      channel: { type: DataTypes.INTEGER, defaultValue: 1 },
      name: { type: DataTypes.STRING(160), allowNull: true },
      rtspUrl: { type: DataTypes.STRING(500), allowNull: true },
      streamUrl: { type: DataTypes.STRING(500), allowNull: true },
      snapshotUrl: { type: DataTypes.STRING(500), allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
      status: { type: DataTypes.STRING(20), defaultValue: 'unknown' },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      ...timestampCols,
    });
    console.log('Created videoCameras');
  }

  // ---- videoEvents ----
  if (await tableExists(qi, 'videoEvents')) {
    console.log('videoEvents already exists, skipping');
  } else {
    await qi.createTable('videoEvents', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      videoCameraId: { type: DataTypes.UUID, allowNull: true },
      videoDeviceId: { type: DataTypes.UUID, allowNull: true },
      type: { type: DataTypes.STRING(20), defaultValue: 'manual' },
      severity: { type: DataTypes.STRING(12), defaultValue: 'medium' },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      title: { type: DataTypes.STRING(200), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING(12), defaultValue: 'new' },
      acknowledgedById: { type: DataTypes.UUID, allowNull: true },
      incidentId: { type: DataTypes.UUID, allowNull: true },
      videoClipId: { type: DataTypes.UUID, allowNull: true },
      stationId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      ...timestampCols,
    });
    console.log('Created videoEvents');
  }

  // ---- videoClips ----
  if (await tableExists(qi, 'videoClips')) {
    console.log('videoClips already exists, skipping');
  } else {
    await qi.createTable('videoClips', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      videoCameraId: { type: DataTypes.UUID, allowNull: true },
      videoDeviceId: { type: DataTypes.UUID, allowNull: true },
      startAt: { type: DataTypes.DATE, allowNull: true },
      endAt: { type: DataTypes.DATE, allowNull: true },
      durationSec: { type: DataTypes.INTEGER, allowNull: true },
      url: { type: DataTypes.STRING(500), allowNull: true },
      thumbnailUrl: { type: DataTypes.STRING(500), allowNull: true },
      label: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: DataTypes.STRING(12), defaultValue: 'pending' },
      incidentId: { type: DataTypes.UUID, allowNull: true },
      shareToken: { type: DataTypes.STRING(80), allowNull: true },
      shareExpiresAt: { type: DataTypes.DATE, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      ...timestampCols,
    });
    console.log('Created videoClips');
  }

  console.log('Video surveillance migration complete');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
