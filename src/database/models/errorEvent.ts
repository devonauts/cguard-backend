/**
 * errorEvent — one row per captured backend error/exception. Written from the
 * single choke point (ApiResponseHandler.error 500 branch) plus the two process
 * crash handlers in server.ts, via lib/errorTracker.ts. This is the persistence
 * behind the superadmin "Errores" page: before it, every 500/crash was
 * console-only across rotating per-worker PM2 logs and invisible to operators.
 *
 * `fingerprint` groups occurrences of the same error (name + normalized message
 * + top stack frame) so the UI can show top patterns + rates. tenantId/userId/
 * route/requestId attribute each occurrence (seeded from the request context).
 * Platform-wide crashes (no request) leave those null.
 */
export default function (sequelize, DataTypes) {
  const errorEvent = sequelize.define(
    'errorEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // Stable group key for "same" errors (see errorTracker.fingerprint()).
      fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(128), allowNull: true },
      message: { type: DataTypes.TEXT, allowNull: true },
      stack: { type: DataTypes.TEXT, allowNull: true },
      statusCode: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 500 },
      method: { type: DataTypes.STRING(8), allowNull: true },
      // The request route/path that produced the error (from request context).
      route: { type: DataTypes.STRING(255), allowNull: true },
      // request | unhandledRejection | uncaughtException | manual
      source: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'request' },
      // Nullable: platform-wide crashes have no tenant/user.
      tenantId: { type: DataTypes.UUID, allowNull: true },
      userId: { type: DataTypes.UUID, allowNull: true },
      ip: { type: DataTypes.STRING(64), allowNull: true },
      userAgent: { type: DataTypes.STRING(255), allowNull: true },
      requestId: { type: DataTypes.STRING(32), allowNull: true },
      pmInstance: { type: DataTypes.STRING(8), allowNull: true },
      // Operators can mark a pattern resolved; new occurrences arrive unresolved.
      resolved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      resolvedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      timestamps: true,
      indexes: [
        { fields: ['fingerprint'] },
        { fields: ['createdAt'] },
        { fields: ['tenantId'] },
        { fields: ['resolved'] },
        { fields: ['statusCode'] },
      ],
    },
  );

  return errorEvent;
}
