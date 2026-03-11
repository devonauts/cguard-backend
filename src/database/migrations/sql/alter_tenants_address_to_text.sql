-- Migration: make address fields TEXT to allow longer, free-form Ecuadorian addresses
-- Run this in your Postgres database migration system (psql or your migration tool)

ALTER TABLE IF EXISTS tenants
  ALTER COLUMN IF EXISTS address TYPE text,
  ALTER COLUMN IF EXISTS addressline2 TYPE text;

-- If your column names are different (e.g., "addressLine2"), run the appropriate ALTER.
-- Example for camelCase column name in Postgres (if quoted):
-- ALTER TABLE IF EXISTS tenants ALTER COLUMN "addressLine2" TYPE text;

-- Note: ensure you have a DB backup before running schema migrations.
