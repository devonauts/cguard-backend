-- Safe migration SQL to add address fields to `tenants` for MySQL or PostgreSQL.
-- Pick the appropriate block for your DB and run it (psql for Postgres, or mysql client for MySQL).

-- ==================== PostgreSQL ====================
-- Run this in psql (psql -d yourdb -f add_tenants_address_fields_safe.sql)

-- DO block ensures idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'tenants' AND column_name = 'address'
  ) THEN
    ALTER TABLE tenants ADD COLUMN address TEXT NOT NULL DEFAULT '';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'tenants' AND column_name = 'addressLine2'
  ) THEN
    ALTER TABLE tenants ADD COLUMN "addressLine2" TEXT NOT NULL DEFAULT '';
  END IF;
END$$;

-- ==================== MySQL (8.0+) ====================
-- Run this in the mysql client (mysql -u user -p yourdb < add_tenants_address_fields_safe.sql)

-- MySQL 8 supports ALTER TABLE ADD COLUMN IF NOT EXISTS
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS addressLine2 TEXT NOT NULL DEFAULT '';

-- Fallback (older MySQL): run these queries manually if IF NOT EXISTS isn't supported
-- SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'address';
-- If 0 then run: ALTER TABLE tenants ADD COLUMN address TEXT NOT NULL DEFAULT '';
-- Repeat for addressLine2

-- NOTE: Make a full backup before running schema migrations.
