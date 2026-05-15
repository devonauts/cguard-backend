require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: create inventory_items table...');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'inventoryItems' AND TABLE_SCHEMA = DATABASE()`,
    );

    if (!tableExists) {
      await queryInterface.createTable('inventoryItems', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        name: { type: DataTypes.STRING(255), allowNull: false },
        type: {
          type: DataTypes.ENUM(
            'radio','arma','chaleco_antibalas','tolete','pito','linterna',
            'bitacora','cinto_completo','poncho_de_aguas','detector_de_metales',
            'caseta','vehiculo','otro',
          ),
          allowNull: false,
          defaultValue: 'otro',
        },
        brand: { type: DataTypes.STRING(100), allowNull: true },
        modelName: { type: DataTypes.STRING(100), allowNull: true },
        serialNumber: { type: DataTypes.STRING(255), allowNull: true },
        condition: { type: DataTypes.ENUM('bueno','regular','dañado'), allowNull: false, defaultValue: 'bueno' },
        status: { type: DataTypes.ENUM('disponible','asignado','en_mantenimiento','retirado'), allowNull: false, defaultValue: 'disponible' },
        notes: { type: DataTypes.TEXT, allowNull: true },
        expirationDate: { type: DataTypes.DATEONLY, allowNull: true },
        importHash: { type: DataTypes.STRING(255), allowNull: true },
        tenantId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
        createdById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        updatedById: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: { type: DataTypes.DATE, allowNull: true },
      });
      console.log('Table inventoryItems created.');
    } else {
      console.log('Table inventoryItems already exists, skipping.');
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
