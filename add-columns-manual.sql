-- Ejecuta estas consultas en MySQL Workbench o phpMyAdmin
-- para agregar todas las columnas necesarias

-- 1. Verificar si las columnas existen
SELECT COLUMN_NAME 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'cguard_db' 
  AND TABLE_NAME = 'clientAccounts';

-- 2. Agregar columnas si no existen
ALTER TABLE clientAccounts 
ADD COLUMN IF NOT EXISTS lastName VARCHAR(200) NULL AFTER name,
ADD COLUMN IF NOT EXISTS company VARCHAR(200) NULL AFTER lastName,
ADD COLUMN IF NOT EXISTS taxId VARCHAR(50) NULL AFTER company,
ADD COLUMN IF NOT EXISTS addressComplement VARCHAR(200) NULL AFTER address,
ADD COLUMN IF NOT EXISTS zipCode VARCHAR(20) NULL AFTER addressComplement,
ADD COLUMN IF NOT EXISTS city VARCHAR(100) NULL AFTER zipCode,
ADD COLUMN IF NOT EXISTS country VARCHAR(100) NULL AFTER city,
ADD COLUMN IF NOT EXISTS useSameAddressForBilling TINYINT(1) NOT NULL DEFAULT 1 AFTER country,
ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,8) NULL AFTER active,
ADD COLUMN IF NOT EXISTS longitude DECIMAL(11,8) NULL AFTER latitude;

-- 3. Modificar email y phoneNumber para que sean opcionales
ALTER TABLE clientAccounts 
MODIFY COLUMN email VARCHAR(150) NULL,
MODIFY COLUMN phoneNumber VARCHAR(20) NULL;

-- 4. Verificar que se agregaron correctamente
DESCRIBE clientAccounts;
