require('dotenv').config();

import models from '../models';

/**
 * SMS billing remediation: seed PER-SEGMENT, PER-COUNTRY twilio/sms rates in
 * communicationProviderRates. Until now the only sms rate was a flat 5c
 * wildcard billed per MESSAGE while Twilio bills the platform per SEGMENT
 * (Ecuador termination alone is ~17c/segment) — long/accented messages were
 * sold below cost.
 *
 * Rates seeded (platform price WITH margin, cents per SEGMENT, messageType
 * stays NULL):
 *   countryCode '+593' (Ecuador)  → 20c
 *   countryCode '+1'   (US/CA)    →  2c
 *   countryCode NULL   (wildcard) → 10c  (fail-safe for unlisted countries;
 *                                         the router additionally applies a
 *                                         10c hardcoded floor when NO row
 *                                         matches at all)
 *
 * NOTE for superadmin: there is no rates UI yet — tune prices by editing
 * communicationProviderRates rows directly (costCents is cents/segment).
 *
 * Idempotent:
 *   - country rows are insert-if-absent (an existing row is never touched, so
 *     manual tuning survives re-runs);
 *   - the wildcard row is UPDATED only if it still holds the old 5c
 *     per-message default (any other value is treated as superadmin-tuned and
 *     left alone).
 */
async function migrate() {
  const { sequelize } = models();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'communicationProviderRates' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!tableExists) {
      console.log('communicationProviderRates does not exist — run z20260616c first. Skipping.');
      process.exit(0);
    }

    // Country-specific per-segment rates: insert if absent, never overwrite.
    const countryRates = [
      { country: '+593', cost: 20 }, // Ecuador
      { country: '+1', cost: 2 }, // US/Canada
    ];
    for (const r of countryRates) {
      const [rows]: any = await sequelize.query(
        `SELECT id FROM communicationProviderRates
         WHERE provider = 'twilio' AND channel = 'sms'
           AND countryCode = :country AND messageType IS NULL`,
        { replacements: { country: r.country } },
      );
      if (rows && rows.length) {
        console.log(`  rate twilio/sms ${r.country} already exists — left untouched.`);
        continue;
      }
      await sequelize.query(
        `INSERT INTO communicationProviderRates
           (id, provider, channel, countryCode, messageType, costCents, markupPercentage, currency, active, createdAt, updatedAt)
         VALUES (UUID(), 'twilio', 'sms', :country, NULL, :cost, 0, 'USD', 1, NOW(), NOW())`,
        { replacements: { country: r.country, cost: r.cost } },
      );
      console.log(`  seeded rate: twilio/sms ${r.country} = ${r.cost}c/segment`);
    }

    // Wildcard: bump the old 5c per-message default to 10c per segment. Only
    // touch the exact legacy default so superadmin tuning is never clobbered.
    const [updated]: any = await sequelize.query(
      `UPDATE communicationProviderRates
       SET costCents = 10, updatedAt = NOW()
       WHERE provider = 'twilio' AND channel = 'sms'
         AND countryCode IS NULL AND messageType IS NULL
         AND costCents = 5`,
    );
    const changed = (updated && (updated.affectedRows ?? updated.rowCount)) || 0;
    if (changed) {
      console.log('  wildcard twilio/sms rate: 5c/message → 10c/segment.');
    } else {
      // Ensure the wildcard exists at all (fresh installs).
      const [wildcard]: any = await sequelize.query(
        `SELECT id FROM communicationProviderRates
         WHERE provider = 'twilio' AND channel = 'sms'
           AND countryCode IS NULL AND messageType IS NULL`,
      );
      if (!wildcard || !wildcard.length) {
        await sequelize.query(
          `INSERT INTO communicationProviderRates
             (id, provider, channel, countryCode, messageType, costCents, markupPercentage, currency, active, createdAt, updatedAt)
           VALUES (UUID(), 'twilio', 'sms', NULL, NULL, 10, 0, 'USD', 1, NOW(), NOW())`,
        );
        console.log('  seeded wildcard rate: twilio/sms = 10c/segment');
      } else {
        console.log('  wildcard twilio/sms rate already tuned — left untouched.');
      }
    }

    console.log('✅ per-segment SMS country rates seeded.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
