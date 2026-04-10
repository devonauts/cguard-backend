"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'mysql') {
      await queryInterface.addColumn('siteTours', 'scheduledDays_tmp', {
        type: Sequelize.JSON,
        allowNull: true,
      });

      await queryInterface.sequelize.query(
        `UPDATE siteTours SET scheduledDays_tmp = CASE WHEN scheduledDays IS NULL OR scheduledDays = '' OR JSON_VALID(scheduledDays) = 0 THEN '[]' ELSE scheduledDays END`,
      );

      await queryInterface.removeColumn('siteTours', 'scheduledDays');
      await queryInterface.renameColumn('siteTours', 'scheduledDays_tmp', 'scheduledDays');
    } else {
      await queryInterface.changeColumn('siteTours', 'scheduledDays', {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: true,
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('siteTours', 'scheduledDays', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },
};
