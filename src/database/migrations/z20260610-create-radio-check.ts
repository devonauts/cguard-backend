require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Radio Check / pase de novedades (Phase 1, app-side):
 *   radioCheckSettings  — per-tenant config for the recurring roll call
 *   radioCheckSessions  — one roll-call run (manual or auto)
 *   radioCheckEntries   — per-station leg of a session (the guard's reply lives here)
 *
 * The DB is the source of truth; FCM (to guards) and socket.io (to the CRM) are
 * best-effort nudges. lastAutoRunAt on settings doubles as the cluster-safe claim
 * column the scheduler uses to ensure exactly one PM2 worker fires an auto run.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();
  const exists = async (t: string) => { try { await qi.describeTable(t); return true; } catch { return false; } };
  const tenantFk = {
    type: DataTypes.UUID, allowNull: false,
    references: { model: 'tenants', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
  };
  const stamps = {
    createdById: { type: DataTypes.UUID, allowNull: true },
    updatedById: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
  };

  try {
    if (!(await exists('radioCheckSettings'))) {
      console.log('Creating radioCheckSettings...');
      await qi.createTable('radioCheckSettings', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        intervalMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 35 },
        perStationTimeoutSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 180 },
        activeHoursStart: { type: DataTypes.STRING(5), allowNull: true }, // "06:00"; null = 24h
        activeHoursEnd: { type: DataTypes.STRING(5), allowNull: true },
        promptText: { type: DataTypes.TEXT, allowNull: true },
        voiceAnnouncement: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        channel: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'app' }, // app | wave_ptx (phase 2)
        // Doubles as the cluster-safe claim column for the auto scheduler.
        lastAutoRunAt: { type: DataTypes.DATE, allowNull: true },
        tenantId: tenantFk,
        ...stamps,
      });
      await qi.addIndex('radioCheckSettings', ['tenantId'], { unique: true, name: 'uniq_radiocheck_settings_tenant' });
      console.log('✅ radioCheckSettings created');
    } else { console.log('radioCheckSettings exists, skipping'); }

    if (!(await exists('radioCheckSessions'))) {
      console.log('Creating radioCheckSessions...');
      await qi.createTable('radioCheckSessions', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' }, // manual | auto
        initiatedByUserId: { type: DataTypes.UUID, allowNull: true },
        scope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'all' }, // all | station
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'running' }, // running | completed | cancelled
        startedAt: { type: DataTypes.DATE, allowNull: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        summary: { type: DataTypes.TEXT, allowNull: true },
        summaryStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' }, // pending | done | failed | skipped
        totalStations: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        respondedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        noResponseCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        incidentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        tenantId: tenantFk,
        ...stamps,
      });
      await qi.addIndex('radioCheckSessions', ['tenantId', 'status', 'startedAt']);
      console.log('✅ radioCheckSessions created');
    } else { console.log('radioCheckSessions exists, skipping'); }

    if (!(await exists('radioCheckEntries'))) {
      console.log('Creating radioCheckEntries...');
      await qi.createTable('radioCheckEntries', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        sessionId: { type: DataTypes.UUID, allowNull: false },
        stationId: { type: DataTypes.UUID, allowNull: false },
        guardUserId: { type: DataTypes.UUID, allowNull: true },        // users.id of the on-duty guard
        guardSecurityGuardId: { type: DataTypes.UUID, allowNull: true },
        guardName: { type: DataTypes.STRING(200), allowNull: true },   // snapshot
        stationName: { type: DataTypes.STRING(250), allowNull: true }, // snapshot
        seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // station order in the roll call
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'pending' }, // pending|notified|responded|no_response|skipped
        promptText: { type: DataTypes.TEXT, allowNull: true },
        audioUrl: { type: DataTypes.TEXT, allowNull: true },           // privateUrl from the upload pipeline
        transcript: { type: DataTypes.TEXT, allowNull: true },
        transcriptStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' }, // pending|done|failed|skipped
        classification: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'unknown' }, // sin_novedad|novedad|incident|unknown
        replyKind: { type: DataTypes.STRING(8), allowNull: true },     // voice|canned|text
        clientMsgId: { type: DataTypes.STRING(64), allowNull: true },
        notifiedAt: { type: DataTypes.DATE, allowNull: true },
        respondedAt: { type: DataTypes.DATE, allowNull: true },
        timeoutAt: { type: DataTypes.DATE, allowNull: true },
        incidentId: { type: DataTypes.UUID, allowNull: true },
        tenantId: tenantFk,
        ...stamps,
      });
      await qi.addIndex('radioCheckEntries', ['tenantId', 'sessionId', 'seq']);
      await qi.addIndex('radioCheckEntries', ['tenantId', 'guardUserId', 'status']);
      await qi.addIndex('radioCheckEntries', ['tenantId', 'status', 'timeoutAt']);
      // Idempotency: one reply per (tenant, guard, clientMsgId).
      await qi.addIndex('radioCheckEntries', ['tenantId', 'guardUserId', 'clientMsgId'], {
        unique: true, name: 'uniq_radiocheck_clientmsgid', where: { clientMsgId: { [require('sequelize').Op.ne]: null } } as any,
      });
      console.log('✅ radioCheckEntries created');
    } else { console.log('radioCheckEntries exists, skipping'); }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
