/**
 * This script is responsible for create the SQL tables.
 * Run it via `npm run db:create`.
 */
require('dotenv').config();

import models from '../models';

  models()
    .sequelize.sync({ alter: false })
  .then(() => {
    console.log('OK');
    process.exit();
  })
  .catch((error) => {
    // If the error is a MySQL 'Multiple primary key defined', skip it
    const code = error && error.original && error.original.code;
    if (code === 'ER_MULTIPLE_PRI_KEY') {
      console.warn('Ignored ER_MULTIPLE_PRI_KEY during create sync:', error && error.original && error.original.sqlMessage ? error.original.sqlMessage : error.message || error);
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  });
