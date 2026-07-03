import { DataTypes } from 'sequelize';

/**
 * Plan catalog — the editable pricing/tier definitions a superadmin manages.
 *
 * Platform-level (NOT tenant-scoped): one row per sellable tier. A tenant's
 * `plan` string maps to a row here by `key`. Pricing overrides fall back to the
 * flat billingModel defaults when null, so existing per-seat pricing keeps
 * working until a superadmin sets tier-specific prices.
 *
 * - monthlyPerSeatCents / implementationCents: null → use billingModel default.
 * - seatCap: null → unlimited seats.
 * - features: array of entitlement keys (see lib/entitlements.ts). Empty array
 *   is treated as "all features" (fail open) by the resolver.
 */
export default function (sequelize) {
  const planCatalog = sequelize.define(
    'planCatalog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // Stable identifier matched against tenant.plan (e.g. free/growth/enterprise).
      key: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        validate: { notEmpty: true },
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: { notEmpty: true },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // Per-seat monthly price override in cents. Null → billingModel default.
      monthlyPerSeatCents: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // One-time implementation fee override in cents. Null → billingModel default.
      implementationCents: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // Max billable seats. Null → unlimited.
      seatCap: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // Entitlement keys included in this tier. [] → all features (fail open).
      features: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
      },
      // Optional Stripe price id for this tier's recurring seat item.
      stripePriceId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // Whether the tier is currently sellable / assignable.
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      // The tier new self-signup tenants land on. Exactly one should be true.
      isDefault: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      timestamps: true,
      paranoid: true,
      indexes: [
        { unique: true, fields: ['key'], where: { deletedAt: null } },
        { fields: ['active'] },
      ],
    },
  );

  return planCatalog;
}
