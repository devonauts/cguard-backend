-- Migration: add incidentTypeId to incidents table
-- Idempotency is handled by the SQL runner (duplicate/exists errors are tolerated).
ALTER TABLE `incidents`
  ADD COLUMN `incidentTypeId` CHAR(36) NULL AFTER `stationIncidentsId`;

-- Add foreign key constraint when available.
ALTER TABLE `incidents`
  ADD CONSTRAINT `fk_incidents_incidentType` FOREIGN KEY (`incidentTypeId`) REFERENCES `incidentTypes`(`id`) ON DELETE SET NULL;
