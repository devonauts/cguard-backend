/**
 * This module creates the Sequelize to the database and
 * exports all the models.
 */
import fs from 'fs';
import path from 'path';
import Sequelize, { DataTypes } from 'sequelize';
import { getConfig } from '../../config';
const highlight = require('cli-highlight').highlight;

const basename = path.basename(__filename);

function models() {
  const database = {} as any;

  // Resolve dialect with precedence: env var -> config -> default 'mysql'
  // Resolve dialect with precedence: env var -> config -> default 'mysql'
  const rawDial = (process.env.DATABASE_DIALECT as string) || getConfig().DATABASE_DIALECT || 'mysql';
  const cleaned = (typeof rawDial === 'string' ? rawDial.trim().toLowerCase() : rawDial) || 'mysql';
  const resolvedDialect = ['undefined', 'null', ''].includes(cleaned) ? 'mysql' : cleaned;

  // Debug: show what dialect we resolved (helps diagnose migrations)
  try {
    console.log('models/index.ts: resolvedDialect=', resolvedDialect);
    console.log('models/index.ts: process.env.DATABASE_DIALECT=', process.env.DATABASE_DIALECT);
    console.log('models/index.ts: getConfig().DATABASE_DIALECT=', getConfig().DATABASE_DIALECT);
  } catch (e) {
    // ignore logging errors in environments that restrict console
  }

  // Ensure process.env has a sane value (some .env files set 'undefined' as text)
  process.env.DATABASE_DIALECT = process.env.DATABASE_DIALECT || resolvedDialect;

  let sequelize = new (<any>Sequelize)(
    getConfig().DATABASE_DATABASE,
    getConfig().DATABASE_USERNAME,
    getConfig().DATABASE_PASSWORD,
    {
      host: getConfig().DATABASE_HOST,
      port: getConfig().DATABASE_PORT || 3307,
      dialect: resolvedDialect,
      timezone: getConfig().DATABASE_TIMEZONE || '+00:00',
      logging:
        getConfig().DATABASE_LOGGING === 'true'
          ? (log) =>
              console.log(
                highlight(log, {
                  language: 'sql',
                  ignoreIllegals: true,
                }),
              )
          : false,
    },
  );

  fs.readdirSync(__dirname)
    .filter(function (file) {
      return (
        file.indexOf('.') !== 0 &&
        file !== basename &&
        (file.slice(-3) === '.js' ||
          file.slice(-3) === '.ts')
      );
    })
    .forEach(function (file) {
      const model = require(path.join(__dirname, file)).default(sequelize, DataTypes);
      database[model.name] = model;
    });

  Object.keys(database).forEach(function (modelName) {
    if (database[modelName].associate) {
      database[modelName].associate(database);
    }
  });

  // Backwards-compatible aliases for models referenced by `as` in includes
  // Some repositories expect `options.database.postSite` to exist (alias
  // used in includes). Map it to the `businessInfo` model so Sequelize
  // receives a proper Model in `include` calls.
  if (database.businessInfo) {
    database.postSite = database.businessInfo;
  }

  database.sequelize = sequelize;
  database.Sequelize = Sequelize;

  return database;
}

export default models;
