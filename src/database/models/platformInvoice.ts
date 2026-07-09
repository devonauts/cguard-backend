import { DataTypes } from 'sequelize';

/**
 * Platform subscription invoices — the Stripe invoices CGuardPro charges each
 * TENANT for their per-user subscription (implementation fee included on the
 * first one). Written by the Stripe webhook and by the on-demand sync from the
 * billing endpoints, keyed by `stripeInvoiceId` so re-delivery/re-sync is a
 * harmless upsert.
 *
 * NOT the `invoice` model, which is the tenant→their-clients invoicing feature.
 */
export default function (sequelize) {
  const platformInvoice = sequelize.define(
    'platformInvoice',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      stripeInvoiceId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      stripeCustomerId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      stripeSubscriptionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // Stripe's human invoice number (e.g. "F5A1B2C3-0001").
      number: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      // Stripe invoice status: draft | open | paid | void | uncollectible.
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'open',
      },
      amountDueCents: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      amountPaidCents: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      currency: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'usd',
      },
      periodStart: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      periodEnd: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Stripe-hosted pages: the payable/viewable invoice and the PDF download.
      hostedInvoiceUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      invoicePdfUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Joined line-item descriptions, for display without another Stripe call.
      linesSummary: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // When Stripe created the invoice (billing date shown to the customer).
      issuedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      indexes: [
        { unique: true, fields: ['stripeInvoiceId'] },
        { fields: ['tenantId'] },
        { fields: ['stripeCustomerId'] },
        { fields: ['status'] },
      ],
    },
  );

  return platformInvoice;
}
