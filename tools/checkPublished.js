require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const modelsFactory = require('../dist/database/models').default;

(async () => {
  try{
    const m = modelsFactory();
    const [results, meta] = await m.sequelize.query("SHOW COLUMNS FROM services LIKE 'publishedOnMobile'");
      console.log('RESULTS:', JSON.stringify(results, null, 2));
      if (!results || results.length === 0) {
        console.log('publishedOnMobile column not found — adding it now...');
        await m.sequelize.query("ALTER TABLE services ADD COLUMN `publishedOnMobile` BOOLEAN NOT NULL DEFAULT FALSE;");
        const [after, _] = await m.sequelize.query("SHOW COLUMNS FROM services LIKE 'publishedOnMobile'");
        console.log('AFTER ALTER:', JSON.stringify(after, null, 2));
      }
    await m.sequelize.close();
  }catch(e){
    console.error('ERROR', e);
    process.exit(1);
  }
})();
