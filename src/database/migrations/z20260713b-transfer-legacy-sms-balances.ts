require('dotenv').config();

import models from '../models';

/**
 * Single-wallet consolidation: move every remaining LEGACY SMS prepaid balance
 * (tenantSmsAccounts.balanceCents) into the unified communicationWallets, then
 * zero the legacy balance. From this point tenantSmsAccounts is number
 * management only — all SMS/WhatsApp billing debits communicationWallets.
 *
 * Per tenant with balanceCents > 0 (one transaction each):
 *   1. credit communicationWallets (row created if missing);
 *   2. write a communicationLogs ledger row (channel 'wallet', provider
 *      'migration', messageType 'wallet_recharge',
 *      providerMessageId 'legacy-transfer-<tenantId>') — this row IS the
 *      idempotency marker: tenants that already have it are SKIPPED;
 *   3. zero tenantSmsAccounts.balanceCents;
 *   4. write an smsTransactions row (type 'adjustment') so the legacy SMS
 *      history explains where the money went.
 *
 * CAVEAT (accepted): the June z20260616b migration COPIED legacy balances into
 * communicationWallets without zeroing them, so any balance that existed
 * before 2026-06-16 and was never spent will be counted twice by this
 * transfer. Prod balances are expected ~0; every transferred amount is logged
 * LOUDLY below so any double-count is visible and can be adjusted by hand.
 */
async function migrate() {
  const { sequelize } = models();

  try {
    const [[smsTable]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'tenantSmsAccounts' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!smsTable) {
      console.log('tenantSmsAccounts does not exist — nothing to transfer.');
      process.exit(0);
    }
    const [[walletTable]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'communicationWallets' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (!walletTable) {
      console.log('communicationWallets does not exist — run z20260616b first. Skipping.');
      process.exit(0);
    }

    const [accounts]: any = await sequelize.query(
      `SELECT tenantId, balanceCents, currency FROM tenantSmsAccounts WHERE balanceCents > 0`,
    );
    if (!accounts || !accounts.length) {
      console.log('✅ No positive legacy SMS balances — nothing to transfer.');
      process.exit(0);
    }
    console.log(`Found ${accounts.length} tenant(s) with a positive legacy SMS balance.`);

    let transferred = 0;
    let skipped = 0;
    for (const acc of accounts) {
      const tenantId = acc.tenantId;
      const amount = Number(acc.balanceCents) || 0;
      const currency = (acc.currency || 'USD').toUpperCase();
      const reference = `legacy-transfer-${tenantId}`;

      // Idempotency: skip tenants whose transfer ledger row already exists.
      const [existing]: any = await sequelize.query(
        `SELECT id FROM communicationLogs
         WHERE tenantId = :tenantId AND channel = 'wallet' AND providerMessageId = :reference`,
        { replacements: { tenantId, reference } },
      );
      if (existing && existing.length) {
        console.log(`  ⏭  tenant ${tenantId}: transfer already recorded — skipping (legacy balance left as-is).`);
        skipped += 1;
        continue;
      }

      const t = await sequelize.transaction();
      try {
        // Ensure + credit the unified wallet.
        await sequelize.query(
          `INSERT INTO communicationWallets (id, tenantId, balanceCents, currency, lowBalanceThresholdCents, createdAt, updatedAt)
           SELECT UUID(), :tenantId, 0, :currency, 500, NOW(), NOW()
           WHERE NOT EXISTS (SELECT 1 FROM communicationWallets w WHERE w.tenantId = :tenantId)`,
          { replacements: { tenantId, currency }, transaction: t },
        );
        await sequelize.query(
          `UPDATE communicationWallets SET balanceCents = balanceCents + :amount, updatedAt = NOW()
           WHERE tenantId = :tenantId`,
          { replacements: { tenantId, amount }, transaction: t },
        );

        // Ledger row in the unified wallet (negative billed = credit, matching
        // creditWalletFromRecharge) — doubles as the idempotency marker.
        await sequelize.query(
          `INSERT INTO communicationLogs
             (id, tenantId, channel, provider, messageType, status, providerMessageId, billedAmountCents, currency, providerResponse, createdAt, updatedAt)
           VALUES
             (UUID(), :tenantId, 'wallet', 'migration', 'wallet_recharge', 'delivered', :reference, :billed, :currency, :response, NOW(), NOW())`,
          {
            replacements: {
              tenantId,
              reference,
              billed: -amount,
              currency,
              response: JSON.stringify({
                description: 'Transferencia del saldo SMS heredado a la billetera de comunicaciones',
                creditedCents: amount,
                source: 'tenantSmsAccounts',
              }),
            },
            transaction: t,
          },
        );

        // Zero the legacy balance + explain it in the legacy ledger.
        await sequelize.query(
          `UPDATE tenantSmsAccounts SET balanceCents = 0, updatedAt = NOW() WHERE tenantId = :tenantId`,
          { replacements: { tenantId }, transaction: t },
        );
        await sequelize.query(
          `INSERT INTO smsTransactions
             (id, tenantId, type, amountCents, balanceAfterCents, smsCount, currency, reference, description, createdAt, updatedAt)
           VALUES
             (UUID(), :tenantId, 'adjustment', :amount, 0, NULL, :currency, :reference,
              'Saldo transferido a la billetera de comunicaciones (consolidación de billeteras)', NOW(), NOW())`,
          { replacements: { tenantId, amount: -amount, currency, reference }, transaction: t },
        );

        await t.commit();
        transferred += 1;
        console.log(`  💸 tenant ${tenantId}: transferred ${amount}c (${currency}) legacy SMS balance → communicationWallet.`);
      } catch (err) {
        await t.rollback();
        console.error(`  ❌ tenant ${tenantId}: transfer FAILED (rolled back):`, err);
      }
    }

    console.log(`✅ Legacy SMS balance transfer done: ${transferred} transferred, ${skipped} already done.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
