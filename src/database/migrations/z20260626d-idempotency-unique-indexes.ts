require('dotenv').config();

import models from '../models';

/**
 * Defense-in-depth unique indexes backing the Phase-3 idempotency fixes:
 *  - deviceIdInformations(tenantId, deviceId)  → one device row per token/device
 *  - twilioMessages(twilioSid)                 → Twilio retries can't duplicate
 *  - securityGuards active_guard_key            → one ACTIVE guard per (guard,tenant)
 *
 * MySQL has no partial indexes, so the securityGuards rule uses a STORED
 * GENERATED column that is NULL for soft-deleted rows (NULLs are not unique),
 * mirroring guardAssignment.activeSlotKey. Each step is independent + idempotent
 * and tolerates "already exists" so re-runs / the ledger are safe.
 */
async function migrate() {
  const { sequelize } = models();
  const q = sequelize;

  const step = async (label: string, fn: () => Promise<any>) => {
    try {
      await fn();
      console.log(`✅ ${label}`);
    } catch (e: any) {
      const msg = String(e && e.message || e);
      if (/duplicate key name|already exists|duplicate column name|Duplicate entry/i.test(msg)) {
        console.log(`↩︎  ${label} — already applied (${msg.split('\n')[0]})`);
      } else {
        console.error(`❌ ${label}:`, msg);
        throw e;
      }
    }
  };

  const indexExists = async (table: string, name: string) => {
    const [rows]: any = await q.query(
      `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
      { replacements: [table, name] },
    );
    return rows && rows.length > 0;
  };
  const columnExists = async (table: string, col: string) => {
    const [rows]: any = await q.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
      { replacements: [table, col] },
    );
    return rows && rows.length > 0;
  };

  try {
    // ── deviceIdInformations: dedup then unique (tenantId, deviceId) ──────────
    await step('dedup deviceIdInformations(tenantId,deviceId)', async () => {
      await q.query(`
        DELETE FROM deviceIdInformations WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY tenantId, deviceId
              ORDER BY lastSeenAt DESC, createdAt DESC, id DESC
            ) rn
            FROM deviceIdInformations WHERE deviceId IS NOT NULL
          ) x WHERE x.rn > 1
        )`);
    });
    await step('add unique index deviceIdInformations(tenantId,deviceId)', async () => {
      if (!(await indexExists('deviceIdInformations', 'uniq_device_tenant_deviceid'))) {
        await q.query(`ALTER TABLE deviceIdInformations ADD UNIQUE INDEX uniq_device_tenant_deviceid (tenantId, deviceId)`);
      }
    });

    // ── twilioMessages: unique (twilioSid) — NULLs allowed ───────────────────
    await step('add unique index twilioMessages(twilioSid)', async () => {
      if (!(await indexExists('twilioMessages', 'uniq_twilio_sid'))) {
        await q.query(`ALTER TABLE twilioMessages ADD UNIQUE INDEX uniq_twilio_sid (twilioSid)`);
      }
    });

    // ── securityGuards: one ACTIVE guard per (guardId, tenantId) ─────────────
    await step('add securityGuards.active_guard_key generated column', async () => {
      if (!(await columnExists('securityGuards', 'active_guard_key'))) {
        await q.query(`
          ALTER TABLE securityGuards
          ADD COLUMN active_guard_key VARCHAR(80)
          GENERATED ALWAYS AS (CASE WHEN deletedAt IS NULL THEN CONCAT(guardId, '-', tenantId) ELSE NULL END) STORED`);
      }
    });
    await step('add unique index securityGuards(active_guard_key)', async () => {
      if (!(await indexExists('securityGuards', 'uniq_active_guard'))) {
        await q.query(`ALTER TABLE securityGuards ADD UNIQUE INDEX uniq_active_guard (active_guard_key)`);
      }
    });

    console.log('z20260626d done.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
