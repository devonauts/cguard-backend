import models from '../database/models';

(async () => {
  const db = models();
  try {
    console.log('Connected via project models, running ALTER TABLE...');
    await db.sequelize.query('ALTER TABLE `visitorLogs` ADD COLUMN `stationId` CHAR(36) NULL;');
    console.log('ALTER TABLE executed');
  } catch (err) {
    console.log('ALTER TABLE error:', err && (err as any).message ? (err as any).message : err);
  } finally {
    await db.sequelize.close();
  }
})();
