-- Migration: add callerName to incidents table
ALTER TABLE `incidents`
  ADD COLUMN IF NOT EXISTS `callerName` VARCHAR(255) NULL AFTER `description`;
