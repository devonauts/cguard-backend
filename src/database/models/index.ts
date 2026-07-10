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

// Singleton: the first call builds the Sequelize instance + model graph; every
// subsequent call (including direct require('../database/models').default()
// call sites AND databaseInit()) returns the exact same object. Without this,
// each call created a brand-new Sequelize instance with its own connection
// pool that was never closed — a permanent MySQL connection + memory leak.
let cachedDatabase: any = null;

function models() {
  if (cachedDatabase) {
    return cachedDatabase;
  }

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
      // Connection pool — previously UNSET, so every worker silently ran at
      // Sequelize's default max=5 connections (the DATABASE_POOL_* env vars were
      // dead config). Wire them through so the pool is sized for real load.
      pool: {
        max: Number(getConfig().DATABASE_POOL_MAX) || Number(process.env.DATABASE_POOL_MAX) || 20,
        min: Number(getConfig().DATABASE_POOL_MIN) || Number(process.env.DATABASE_POOL_MIN) || 2,
        acquire: Number(getConfig().DATABASE_POOL_ACQUIRE) || Number(process.env.DATABASE_POOL_ACQUIRE) || 30000,
        idle: Number(getConfig().DATABASE_POOL_IDLE) || Number(process.env.DATABASE_POOL_IDLE) || 10000,
        evict: Number(getConfig().DATABASE_POOL_EVICT) || Number(process.env.DATABASE_POOL_EVICT) || 1000,
      },
      // Self-heal transient DB failures at the driver layer: retry a query that hits
      // a connection error (dropped socket — the query never reached the DB) or a
      // deadlock/lock-wait-timeout (MySQL rolled it back). Connection retries can't
      // double-apply a write; this keeps a brief blip from ever surfacing to the
      // request handler. Deliberately NOT retried: pool-acquire timeout,
      // ER_CON_COUNT_ERROR and "Too many connections" — those signal saturation, and
      // re-queueing multiplies load exactly when the pool is starved. They must
      // surface fast so authMiddleware's isInfrastructureError path can 503.
      // (The generic /SequelizeConnectionError/ pattern is also omitted on purpose:
      // the mysql dialect wraps ER_CON_COUNT_ERROR in the base ConnectionError, so
      // that pattern would silently re-add retry-on-saturation. The specific
      // subclasses + errno codes below still cover transient network blips.)
      retry: {
        max: 3,
        match: [
          /SequelizeConnectionRefusedError/,
          /SequelizeHostNotReachableError/,
          /SequelizeConnectionTimedOutError/,
          /ETIMEDOUT/,
          /ECONNRESET/,
          /ECONNREFUSED/,
          /EPIPE/,
          /PROTOCOL_CONNECTION_LOST/,
          /SequelizeDeadlockError/,
          /ER_LOCK_DEADLOCK/,
          /ER_LOCK_WAIT_TIMEOUT/,
        ],
      },
      // benchmark: true → the logging fn receives the query's exec time (ms), which
      // we feed to the slow-query monitor (>=0.1s) for the observability page,
      // regardless of DATABASE_LOGGING.
      benchmark: true,
      logging: (log: any, timing?: number) => {
        if (typeof timing === 'number') {
          try {
            require('../../lib/slowQueryMonitor').recordQuery(log, timing);
          } catch {
            /* monitor optional */
          }
        }
        if (getConfig().DATABASE_LOGGING === 'true') {
          console.log(highlight(String(log), { language: 'sql', ignoreIllegals: true }));
        }
      },
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

  cachedDatabase = database;

  return database;
}

export default models;
