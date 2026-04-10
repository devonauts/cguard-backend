"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();
    const type = dialect === 'mysql' ? Sequelize.JSON : Sequelize.ARRAY(Sequelize.STRING);

    if (dialect === 'mysql') {
      // Normalize invalid JSON values before changing the column type.
      await queryInterface.sequelize.query(
        `UPDATE siteTours SET scheduledDays = '[]' WHERE scheduledDays IS NULL OR scheduledDays = '' OR JSON_VALID(scheduledDays) = 0`,
      );
    }

    await queryInterface.changeColumn('siteTours', 'scheduledDays', {
      type,
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('siteTours', 'scheduledDays', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },
};
