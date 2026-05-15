import { QueryInterface, DataTypes } from 'sequelize';

export default {
  up: async (queryInterface: QueryInterface) => {
    const tableDesc = await queryInterface.describeTable('users');

    if (!tableDesc['middleName']) {
      await queryInterface.addColumn('users', 'middleName', {
        type: DataTypes.STRING(80),
        allowNull: true,
      });
    }
    if (!tableDesc['homeAddress']) {
      await queryInterface.addColumn('users', 'homeAddress', {
        type: DataTypes.STRING(512),
        allowNull: true,
      });
    }
    if (!tableDesc['homeAddressLat']) {
      await queryInterface.addColumn('users', 'homeAddressLat', {
        type: DataTypes.DOUBLE,
        allowNull: true,
      });
    }
    if (!tableDesc['homeAddressLng']) {
      await queryInterface.addColumn('users', 'homeAddressLng', {
        type: DataTypes.DOUBLE,
        allowNull: true,
      });
    }
    if (!tableDesc['bloodType']) {
      await queryInterface.addColumn('users', 'bloodType', {
        type: DataTypes.STRING(10),
        allowNull: true,
      });
    }
    if (!tableDesc['identificationNumber']) {
      await queryInterface.addColumn('users', 'identificationNumber', {
        type: DataTypes.STRING(40),
        allowNull: true,
      });
    }
  },

  down: async (queryInterface: QueryInterface) => {
    const tableDesc = await queryInterface.describeTable('users');
    for (const col of ['middleName', 'homeAddress', 'homeAddressLat', 'homeAddressLng', 'bloodType', 'identificationNumber']) {
      if (tableDesc[col]) {
        await queryInterface.removeColumn('users', col);
      }
    }
  },
};
