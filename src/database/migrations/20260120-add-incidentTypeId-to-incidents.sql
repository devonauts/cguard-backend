-- Migration: add incidentTypeId to incidents table
ALTER TABLE `incidents`
  ADD COLUMN IF NOT EXISTS `incidentTypeId` CHAR(36) NULL AFTER `stationIncidentsId`;

-- Add foreign key constraint if possible
ALTER TABLE `incidents`
  ADD CONSTRAINT IF NOT EXISTS `fk_incidents_incidentType` FOREIGN KEY (`incidentTypeId`) REFERENCES `incidentTypes`(`id`) ON DELETE SET NULL;
