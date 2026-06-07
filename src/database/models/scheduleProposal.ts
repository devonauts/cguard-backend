import { DataTypes } from 'sequelize';

/**
 * A DRAFT schedule (horario) proposal. Generation writes here — never to the
 * live `shift` table — so the worker-app and every existing read path only ever
 * see published shifts. A proposal holds a staged set of `proposedShift` rows
 * (the diff vs. the live schedule) and is applied atomically on publish.
 *
 * status: draft → (published | discarded)
 * scope:  'station' | 'postSite' | 'tenant'  (what the generation covered)
 */
export default function (sequelize) {
  const scheduleProposal = sequelize.define(
    'scheduleProposal',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      title: { type: DataTypes.STRING(200), allowNull: true },
      scope: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'station', // station | postSite | tenant
      },
      stationId: { type: DataTypes.UUID, allowNull: true },
      postSiteId: { type: DataTypes.UUID, allowNull: true },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'draft', // draft | published | discarded
      },
      windowStart: { type: DataTypes.DATE, allowNull: true },
      windowEnd: { type: DataTypes.DATE, allowNull: true },
      // Snapshot of the inputs used to generate (rotation/cost params, kind).
      params: { type: DataTypes.JSON, allowNull: true },
      // Cached diff counts: { added, removed, changed, kept, guardsAffected }.
      summary: { type: DataTypes.JSON, allowNull: true },
      generatedById: { type: DataTypes.UUID, allowNull: true },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      publishedAt: { type: DataTypes.DATE, allowNull: true },
      importHash: {
        type: DataTypes.STRING(255),
        allowNull: true,
        validate: { len: [0, 255] },
      },
    },
    {
      indexes: [
        { fields: ['tenantId', 'status'] },
        { fields: ['tenantId', 'stationId'] },
        { fields: ['tenantId', 'postSiteId'] },
        {
          unique: true,
          fields: ['importHash', 'tenantId'],
          where: { deletedAt: null },
        },
      ],
      timestamps: true,
      paranoid: true,
    },
  );

  scheduleProposal.associate = (models) => {
    models.scheduleProposal.belongsTo(models.tenant, {
      as: 'tenant',
      foreignKey: { allowNull: false },
      onDelete: 'CASCADE',
    });
    models.scheduleProposal.hasMany(models.proposedShift, {
      as: 'proposedShifts',
      foreignKey: 'proposalId',
      constraints: false,
    });
    models.scheduleProposal.belongsTo(models.user, {
      as: 'generatedBy',
      foreignKey: 'generatedById',
      constraints: false,
    });
  };

  return scheduleProposal;
}
