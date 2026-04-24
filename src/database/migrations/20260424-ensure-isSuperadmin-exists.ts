/**
 * Migration: ensure isSuperadmin column exists on users (idempotent)
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      const desc = await queryInterface.describeTable('users').catch(() => null);
      if (!desc) {
        console.log('Table `users` does not exist, skipping isSuperadmin check');
        return;
      }

      const keys = Object.keys(desc || {}).map((k) => String(k).toLowerCase());
      if (!keys.includes('issuperadmin')) {
        console.log('Adding `isSuperadmin` column to `users`');
        await queryInterface.addColumn('users', 'isSuperadmin', {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
      } else {
        console.log('`isSuperadmin` already present on `users`');
      }
    } catch (e) {
      console.warn('Could not ensure isSuperadmin column:', e && e.message ? e.message : e);
      throw e;
    }
  },

  async down(queryInterface) {
    const desc = await queryInterface.describeTable('users').catch(() => null);
    if (desc && desc.isSuperadmin) {
      await queryInterface.removeColumn('users', 'isSuperadmin');
    }
  },
};
