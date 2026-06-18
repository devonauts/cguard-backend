require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Platform notification center: create superadminNotifications — one row per
 * superadmin notification (incoming call, inbound SMS, …) with a `link` used to
 * route the user on click. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const qi: QueryInterface = sequelize.getQueryInterface();

  try {
    const [[tableExists]]: any = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'superadminNotifications' AND TABLE_SCHEMA = DATABASE()`,
    );
    if (tableExists) {
      console.log('Table superadminNotifications already exists. Skipping.');
      process.exit(0);
    }

    console.log('Creating superadminNotifications table...');
    await qi.createTable('superadminNotifications', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      type: { type: DataTypes.STRING(48), allowNull: false },
      title: { type: DataTypes.STRING(180), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: true },
      link: { type: DataTypes.STRING(255), allowNull: true },
      icon: { type: DataTypes.STRING(32), allowNull: true },
      isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      metadata: { type: DataTypes.JSON, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn('NOW') },
    });

    await qi.addIndex('superadminNotifications', ['isRead', 'createdAt'], {
      name: 'sa_notif_read_created',
    });

    console.log('✅ superadminNotifications created.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
