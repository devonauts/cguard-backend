"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Increase governmentId length to 20
    await queryInterface.changeColumn('securityGuards', 'governmentId', {
      type: Sequelize.STRING(20),
      allowNull: false,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Revert governmentId length back to 10
    await queryInterface.changeColumn('securityGuards', 'governmentId', {
      type: Sequelize.STRING(10),
      allowNull: false,
    });
  },
};
