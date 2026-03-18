const TABLE_CANDIDATES = ['clientAccounts', 'client_account', 'client_accounts'];

module.exports = {
  async migrate(queryInterface, Sequelize) {
    const dialect = (queryInterface.sequelize.options && queryInterface.sequelize.options.dialect) || process.env.DATABASE_DIALECT || 'mysql';

    for (const table of TABLE_CANDIDATES) {
      try {
        const [[{ count }]] = await queryInterface.sequelize.query(
          `SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = 'landline'`
        );
        if (Number(count) > 0) {
          console.log(`Column landline already exists on ${table}, skipping.`);
          continue;
        }

        // Check if table exists
        const [[{ table_count }]] = await queryInterface.sequelize.query(
          `SELECT COUNT(*) as table_count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
        );
        if (Number(table_count) === 0) {
          // table not present, skip
          continue;
        }

        console.log(`Adding column: landline to ${table}...`);

        // Add column
        await queryInterface.addColumn(table, 'landline', {
          type: Sequelize.STRING(20),
          allowNull: true,
        });

        // If faxNumber exists, copy data
        const [[{ fax_exists }]] = await queryInterface.sequelize.query(
          `SELECT COUNT(*) as fax_exists FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = 'faxNumber'`
        );

        if (Number(fax_exists) > 0) {
          console.log(`Copying data from faxNumber to landline on ${table}...`);
          // Update rows where landline is null and faxNumber is not null
          await queryInterface.sequelize.query(
            `UPDATE \`${table}\` SET landline = faxNumber WHERE (landline IS NULL OR landline = '') AND (faxNumber IS NOT NULL AND faxNumber != '')`
          );
        }

        console.log(`landline column added on ${table}`);
      } catch (error) {
        console.warn(`Migration add_landline_to_client_accounts: error for table ${table}:`, (error && (error as any).message) || error);
      }
    }
  },
};
