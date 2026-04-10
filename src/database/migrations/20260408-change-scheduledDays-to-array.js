"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();
    const type = dialect === 'mysql' ? Sequelize.JSON : Sequelize.ARRAY(Sequelize.STRING);

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
