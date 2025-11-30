-- Migration: Update clientAccount table structure
-- Date: 2025-11-25
-- Description: Simplify clientAccount model for multi-tenant architecture

-- Step 1: Add new columns
ALTER TABLE `clientAccounts` 
ADD COLUMN `name` VARCHAR(200) AFTER `id`,
ADD COLUMN `website` VARCHAR(255) AFTER `faxNumber`,
ADD COLUMN `categoryId` CHAR(36) AFTER `website`;

-- Step 2: Migrate data from commercialName to name
UPDATE `clientAccounts` 
SET `name` = COALESCE(`commercialName`, 'Sin nombre')
WHERE `name` IS NULL;

-- Step 3: Make name column NOT NULL
ALTER TABLE `clientAccounts` 
MODIFY COLUMN `name` VARCHAR(200) NOT NULL;

-- Step 4: Update phone and fax field lengths
ALTER TABLE `clientAccounts` 
MODIFY COLUMN `phoneNumber` VARCHAR(20) NOT NULL,
MODIFY COLUMN `faxNumber` VARCHAR(20);

-- Step 5: Drop old columns (CAREFUL: This will delete data!)
-- Uncomment these lines only after backing up your data
-- ALTER TABLE `clientAccounts` DROP COLUMN `contractDate`;
-- ALTER TABLE `clientAccounts` DROP COLUMN `rucNumber`;
-- ALTER TABLE `clientAccounts` DROP COLUMN `commercialName`;
-- ALTER TABLE `clientAccounts` DROP COLUMN `representanteId`;

-- Step 6: Drop junction tables for removed relationships (CAREFUL!)
-- Uncomment these lines only after backing up your data
-- DROP TABLE IF EXISTS `clientAccountPurchasedServicesService`;
-- DROP TABLE IF EXISTS `clientAccountStationsStation`;
-- DROP TABLE IF EXISTS `clientAccountBillingInvoicesBilling`;
-- DROP TABLE IF EXISTS `clientAccountPushNotificationsNotificationRecipient`;

-- Step 7: Add foreign key for category (optional, if category table exists)
-- ALTER TABLE `clientAccounts` 
-- ADD CONSTRAINT `fk_clientAccount_category` 
-- FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) 
-- ON DELETE SET NULL ON UPDATE CASCADE;

-- Verification queries:
-- SELECT * FROM `clientAccounts` LIMIT 5;
-- DESCRIBE `clientAccounts`;
