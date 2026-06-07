/**
 * Add media-gateway fields to videoDevices: streamGatewayBase (the go2rtc/MediaMTX
 * base URL that converts the DVR's RTSP into browser-playable WebRTC/HLS) and
 * streamFormat ('hls'|'webrtc'). Idempotent.
 *
 * Run: npx ts-node src/database/migrations/20260608-add-video-gateway.ts
 */
require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const desc = await qi.describeTable('videoDevices');

  if (!('streamGatewayBase' in desc)) {
    await qi.addColumn('videoDevices', 'streamGatewayBase', { type: DataTypes.STRING(300), allowNull: true });
    console.log('Added videoDevices.streamGatewayBase');
  } else {
    console.log('streamGatewayBase exists, skipping');
  }
  if (!('streamFormat' in desc)) {
    await qi.addColumn('videoDevices', 'streamFormat', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'hls' });
    console.log('Added videoDevices.streamFormat');
  } else {
    console.log('streamFormat exists, skipping');
  }
  process.exit(0);
}

migrate().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
