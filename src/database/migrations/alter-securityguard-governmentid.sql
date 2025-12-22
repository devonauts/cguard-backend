-- Migration: increase governmentId length for securityGuards
-- Date: 2025-12-19
-- Description: Change governmentId column from VARCHAR(10) to VARCHAR(20).

-- MySQL / MariaDB
ALTER TABLE `securityGuards`
  MODIFY COLUMN `governmentId` VARCHAR(20) NOT NULL;

-- PostgreSQL (uncomment if using Postgres)
-- ALTER TABLE "securityGuards"
--   ALTER COLUMN "governmentId" TYPE VARCHAR(20);
-- ALTER TABLE "securityGuards" ALTER COLUMN "governmentId" SET NOT NULL;

-- Verification (MySQL):
-- DESCRIBE `securityGuards`;

-- Notes:
-- - If you run migrations against a production DB, back it up first.
-- - This file targets the runtime table name used by Sequelize (pluralized model name).
-- - No migration is needed for adding 'Primaria' to the allowed values; that change is in the model code.
