require('dotenv').config();

import models from '../models';
import { QueryInterface, DataTypes } from 'sequelize';

async function migrate() {
  const { sequelize } = models();
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log('Starting migration: ensure services.tenantId FK uses ON DELETE CASCADE');

    const [[tableExists]] = await sequelize.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'services' AND TABLE_SCHEMA = DATABASE()`
    );

    if (!tableExists) {
      console.log('Table services does not exist. Abort.');
      process.exit(0);
    }

    const [tenantIdResult] = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'tenantId' AND TABLE_SCHEMA = DATABASE()`
    );

    if ((tenantIdResult as any[]).length === 0) {
      console.log('Column tenantId does not exist on services — adding column with FK to tenants (CASCADE)');
      await queryInterface.addColumn('services', 'tenantId', {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
      console.log('Added tenantId column and FK (CASCADE).');
      console.log('✅ Migration completed successfully.');
      process.exit(0);
    }

    // Find any existing foreign key constraints on services.tenantId referencing tenants(id)
    const [fkRows] = await sequelize.query(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'tenantId' AND REFERENCED_TABLE_NAME = 'tenants' AND TABLE_SCHEMA = DATABASE()`
    );

    if (Array.isArray(fkRows) && (fkRows as any[]).length > 0) {
      for (const r of fkRows as any[]) {
        const name = r.CONSTRAINT_NAME;
        try {
          console.log('Dropping existing foreign key:', name);
          await sequelize.query(`ALTER TABLE \`services\` DROP FOREIGN KEY \`${name}\``);
        } catch (err) {
          console.warn('Could not drop foreign key', name, err && err.message ? err.message : err);
        }
      }
    } else {
      console.log('No existing FK constraint found for services.tenantId');
    }

    // Add FK with ON DELETE CASCADE
    try {
      console.log('Adding FK fk_services_tenant (ON DELETE CASCADE)');
      await sequelize.query(
        `ALTER TABLE \`services\` ADD CONSTRAINT \`fk_services_tenant\` FOREIGN KEY (\`tenantId\`) REFERENCES \`tenants\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;`
      );
      console.log('✅ FK added with ON DELETE CASCADE.');
    } catch (err) {
      console.error('Failed to add FK fk_services_tenant:', err && err.message ? err.message : err);
      process.exit(1);
    }

    console.log('✅ Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error && error.message ? error.message : error);
    process.exit(1);
  }
}

migrate();
