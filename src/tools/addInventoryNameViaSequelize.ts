import models from '../database/models';

(async () => {
  const db = models();
  try {
    console.log('Connected via project models, running ALTER TABLE to add `name` column to inventories...');
    // Use plural table name `inventories` which is Sequelize default for model 'inventory'
    await db.sequelize.query('ALTER TABLE `inventories` ADD COLUMN `name` VARCHAR(255) NULL;');
    console.log('ALTER TABLE executed successfully');
  } catch (err) {
    console.log('ALTER TABLE error:', err && (err as any).message ? (err as any).message : err);
  } finally {
    await db.sequelize.close();
  }
})();
