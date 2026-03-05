-- Add tenantId column to siteTourTags used by the app
-- Adjust table name if your DB uses different naming (e.g., siteTourTag -> siteTourTags)

ALTER TABLE `siteTourTags`
  ADD COLUMN `tenantId` CHAR(36) NOT NULL AFTER `showGeoFence`;

-- Optional: add index to speed up tenant-scoped queries
ALTER TABLE `siteTourTags`
  ADD INDEX `idx_siteTourTags_tenantId` (`tenantId`);

-- Optional: add foreign key constraint (uncomment if you want and ensure `tenants(id)` exists)
-- ALTER TABLE `siteTourTags`
--   ADD CONSTRAINT `fk_siteTourTags_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE CASCADE;
