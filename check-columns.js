require('dotenv').config();
const mysql = require('mysql2/promise');

async function checkColumns() {
  const connection = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_DATABASE,
  });

  try {
    const [columns] = await connection.query(`
      DESCRIBE clientAccounts
    `);
    
    console.log('\n📋 Columnas en la tabla clientAccounts:\n');
    columns.forEach(col => {
      console.log(`  - ${col.Field} (${col.Type}) ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    
    console.log('\n✅ Total de columnas:', columns.length);
    
    // Verificar campos específicos
    const requiredFields = [
      'lastName', 'company', 'taxId', 'addressComplement', 
      'zipCode', 'city', 'country', 'useSameAddressForBilling'
    ];
    
    console.log('\n🔍 Verificando campos nuevos:');
    requiredFields.forEach(field => {
      const exists = columns.find(col => col.Field === field);
      console.log(`  ${exists ? '✅' : '❌'} ${field}`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

checkColumns();
