require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

/**
 * Add users.phoneNumberVerified. The phone-verification flow (authVerifyPhone →
 * PhoneVerificationUseCases → SequelizeUserRepositoryAdapter.updatePhoneVerification
 * → UserRepository.update) sends phoneNumberVerified: true, but the column never
 * existed so the verification result was silently dropped while the endpoint
 * returned success. Idempotent.
 */
async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();
  try {
    const [rows]: any = await sequelize.query(
      `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phoneNumberVerified'`,
    );
    if (rows && rows[0] && Number(rows[0].count) > 0) {
      console.log('Column users.phoneNumberVerified already exists, skipping.');
    } else {
      await queryInterface.addColumn('users', 'phoneNumberVerified', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
      console.log('✅ users.phoneNumberVerified added');
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();
