require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Creating tenant_user_client_accounts table...');

    // Ensure parent table `tenantUsers` exists before creating FKs
    try {
      await queryInterface.describeTable('tenantUsers');
    } catch (err) {
      console.error('Required parent table `tenantUsers` does not exist. Run the migration that creates tenant users first.');
      process.exit(1);
    }

    // Ensure parent table `clientAccounts` exists before creating FKs
    try {
      await queryInterface.describeTable('clientAccounts');
    } catch (err) {
      console.error('Required parent table `clientAccounts` does not exist. Run the migration that creates clientAccounts first (or create the table manually).');
      process.exit(1);
    }

    await queryInterface.createTable('tenant_user_client_accounts', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenantUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tenantUsers',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clientAccountId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'clientAccounts',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    });

    console.log('Creating indexes for tenant_user_client_accounts...');
    try {
      const existing = await queryInterface.showIndex('tenant_user_client_accounts');
      const hasComposite = Array.isArray(existing) && existing.some((i: any) => {
        if (!i || !i.fields) return false;
        const fields = i.fields.map((f: any) => (f.attribute || f.name || f.field));
        return fields.includes('tenantUserId') && fields.includes('clientAccountId') && i.unique === true;
      });

      if (!hasComposite) {
        await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId', 'clientAccountId'], {
          unique: true,
          name: 'tenant_user_client_unique',
        });
      } else {
        console.log('Index tenant_user_client_unique already exists, skipping');
      }

      const hasTenantIdx = Array.isArray(existing) && existing.some((i: any) => {
        if (!i || !i.fields) return false;
        const fields = i.fields.map((f: any) => (f.attribute || f.name || f.field));
        return fields.length === 1 && fields[0] === 'tenantUserId';
      });
      if (!hasTenantIdx) {
        await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId']);
      } else {
        console.log('Index on tenantUserId already exists, skipping');
      }

      const hasClientIdx = Array.isArray(existing) && existing.some((i: any) => {
        if (!i || !i.fields) return false;
        const fields = i.fields.map((f: any) => (f.attribute || f.name || f.field));
        return fields.length === 1 && fields[0] === 'clientAccountId';
      });
      if (!hasClientIdx) {
        await queryInterface.addIndex('tenant_user_client_accounts', ['clientAccountId']);
      } else {
        console.log('Index on clientAccountId already exists, skipping');
      }
    } catch (err) {
      // If showIndex isn't supported or fails, fallback to attempting to add and ignore duplicate-key errors
      try {
        await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId', 'clientAccountId'], {
          unique: true,
          name: 'tenant_user_client_unique',
        });
      } catch (e) {
        console.log('Could not add composite index (may already exist), continuing');
      }
      try { await queryInterface.addIndex('tenant_user_client_accounts', ['tenantUserId']); } catch (e) { /* ignore */ }
      try { await queryInterface.addIndex('tenant_user_client_accounts', ['clientAccountId']); } catch (e) { /* ignore */ }
    }

    console.log('✅ tenant_user_client_accounts created');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
