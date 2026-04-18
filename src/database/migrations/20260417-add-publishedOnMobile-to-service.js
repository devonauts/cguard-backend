"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add publishedOnMobile column to services table
    await queryInterface.addColumn('services', 'publishedOnMobile', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface /*, Sequelize */) {
    await queryInterface.removeColumn('services', 'publishedOnMobile');
  },
};
