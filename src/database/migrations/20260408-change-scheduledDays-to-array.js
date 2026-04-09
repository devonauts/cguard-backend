"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Cambia el tipo de la columna scheduledDays a ARRAY de STRING (solo PostgreSQL)
    await queryInterface.changeColumn("siteTours", "scheduledDays", {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Revertir a string simple (en caso de rollback)
    await queryInterface.changeColumn("siteTours", "scheduledDays", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },
};
