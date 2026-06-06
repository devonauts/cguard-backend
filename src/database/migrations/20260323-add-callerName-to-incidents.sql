-- Migration: add callerName to incidents table (idempotent via benign error handling)
ALTER TABLE `incidents`
  ADD COLUMN `callerName` VARCHAR(255) NULL AFTER `description`;
