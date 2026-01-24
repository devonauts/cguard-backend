-- Migration: create incident_types table
-- Run this SQL against the tenant-aware schema (the project expects a single DB with tenantId on rows)
CREATE TABLE IF NOT EXISTS `incidentTypes` (
  `id` CHAR(36) NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `tenantId` CHAR(36) NOT NULL,
  `createdById` CHAR(36),
  `updatedById` CHAR(36),
  `importHash` VARCHAR(255),
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deletedAt` DATETIME DEFAULT NULL,
  INDEX `incidentTypes_tenant_idx` (`tenantId`),
  INDEX `incidentTypes_name_tenant_idx` (`name`, `tenantId`),
  UNIQUE KEY `incidentTypes_importHash_tenant_unique` (`importHash`, `tenantId`)
);

-- Add foreign-key-like references for informational integrity (may be optional depending on DB privileges)
ALTER TABLE `incidentTypes`
  ADD CONSTRAINT IF NOT EXISTS `fk_incidentTypes_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE CASCADE;
