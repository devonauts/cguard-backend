require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Per-tenant WhatsApp Business (Meta Embedded Signup): each tenant connects its
 * OWN WhatsApp Business account; the platform never owns numbers.
 *
 *  - Creates `tenantWhatsappAccounts` — one row per tenant holding the WABA id,
 *    phone number id and the secretBox-ENCRYPTED business integration token.
 *  - Adds Meta review metadata to `whatsappTemplates` (status + lastSyncAt) so
 *    per-tenant template syncs can mirror APPROVED/PENDING/REJECTED.
 *
 * Idempotent. Run: npx ts-node src/database/migrations/z20260712-create-tenant-whatsapp-accounts.ts
 */

const TABLE = 'tenantWhatsappAccounts';

// ONE WhatsApp account per tenant TODAY. The unique index is NAMED so it can be
// dropped later (and replaced with a plain index) to support multiple numbers
// per tenant without guessing an auto-generated index name.
const TENANT_UNIQUE_INDEX = 'uniq_tenantWhatsappAccounts_tenantId';

async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  const tables = await qi.showAllTables();
  const has = (tables as any[])
    .map((t: any) => (typeof t === 'string' ? t : t.tableName))
    .includes(TABLE);

  if (!has) {
    await qi.createTable(TABLE, {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      // Meta Business Manager id that owns the WABA (owner_business_info.id).
      metaBusinessId: { type: DataTypes.STRING(64), allowNull: true },
      // WhatsApp Business Account id — webhook entry.id routes on this.
      wabaId: { type: DataTypes.STRING(64), allowNull: true },
      phoneNumberId: { type: DataTypes.STRING(64), allowNull: true },
      displayPhoneNumber: { type: DataTypes.STRING(32), allowNull: true },
      // verified_name of the phone number.
      displayName: { type: DataTypes.STRING(255), allowNull: true },
      // Name of the owning Meta business.
      businessName: { type: DataTypes.STRING(255), allowNull: true },
      // Business integration system-user token, secretBox-encrypted at rest.
      accessToken: { type: DataTypes.TEXT, allowNull: true },
      // Business integration tokens generally don't expire — kept for future
      // token-refresh support.
      tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
      qualityRating: { type: DataTypes.STRING(16), allowNull: true },
      messagingLimit: { type: DataTypes.STRING(32), allowNull: true },
      // connected | disconnected | pending | error
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'disconnected' },
      connectedAt: { type: DataTypes.DATE, allowNull: true },
      disconnectedAt: { type: DataTypes.DATE, allowNull: true },
      lastSyncAt: { type: DataTypes.DATE, allowNull: true },
      connectedByUserId: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // One account per tenant TODAY (see TENANT_UNIQUE_INDEX comment above).
    await qi.addIndex(TABLE, ['tenantId'], { name: TENANT_UNIQUE_INDEX, unique: true });
    // Webhook routing does WHERE wabaId = ? (entry.id → tenant).
    await qi.addIndex(TABLE, ['wabaId']);

    console.log(`✅ Created table ${TABLE}`);
  } else {
    console.log(`↷ Table ${TABLE} already exists. Skipping create.`);
  }

  // whatsappTemplates: Meta review status (APPROVED/PENDING/REJECTED) + sync stamp.
  const templates: any = await qi.describeTable('whatsappTemplates');
  if (!templates.status) {
    await qi.addColumn('whatsappTemplates', 'status', {
      type: DataTypes.STRING(20),
      allowNull: true,
    });
    console.log('✅ whatsappTemplates.status added');
  } else {
    console.log('↷ whatsappTemplates.status already exists');
  }
  if (!templates.lastSyncAt) {
    await qi.addColumn('whatsappTemplates', 'lastSyncAt', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    console.log('✅ whatsappTemplates.lastSyncAt added');
  } else {
    console.log('↷ whatsappTemplates.lastSyncAt already exists');
  }
}

migrate()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
