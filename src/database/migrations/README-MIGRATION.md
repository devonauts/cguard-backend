# ClientAccount Database Migration Guide

## ⚠️ IMPORTANTE: Haz un backup de tu base de datos antes de ejecutar la migración

## Opción 1: Migración Automática (Recomendada)

Ejecuta el siguiente comando para migrar automáticamente la base de datos:

```bash
npm run db:migrate:clientAccount
```

Este script:
1. ✅ Agrega las nuevas columnas (`name`, `website`, `categoryId`)
2. ✅ Migra los datos de `commercialName` a `name`
3. ✅ Actualiza las longitudes de `phoneNumber` y `faxNumber`
4. ⚠️ **NO elimina** las columnas antiguas automáticamente por seguridad

## Opción 2: Migración Manual (SQL)

Si prefieres ejecutar la migración manualmente, usa el archivo SQL:

```bash
mysql -u tu_usuario -p tu_base_de_datos < src/database/migrations/update-clientAccount-schema.sql
```

O ejecuta el SQL directamente en tu cliente de MySQL/PostgreSQL.

## Después de la Migración

### 1. Verificar que la migración funcionó

Conéctate a tu base de datos y ejecuta:

```sql
DESCRIBE clientAccounts;
SELECT * FROM clientAccounts LIMIT 5;
```

Deberías ver las nuevas columnas: `name`, `website`, `categoryId`

### 2. Eliminar columnas antiguas (OPCIONAL)

**⚠️ SOLO después de verificar que todo funciona correctamente**, puedes eliminar las columnas antiguas:

```sql
ALTER TABLE `clientAccounts` 
DROP COLUMN `contractDate`,
DROP COLUMN `rucNumber`,
DROP COLUMN `commercialName`,
DROP COLUMN `representanteId`;
```

### 3. Eliminar tablas de relaciones (OPCIONAL)

**⚠️ SOLO si ya no las necesitas**, elimina las tablas de junction:

```sql
DROP TABLE IF EXISTS `clientAccountPurchasedServicesService`;
DROP TABLE IF EXISTS `clientAccountStationsStation`;
DROP TABLE IF EXISTS `clientAccountBillingInvoicesBilling`;
DROP TABLE IF EXISTS `clientAccountPushNotificationsNotificationRecipient`;
```

## Solución de Problemas

### Error: Column 'name' already exists
La migración ya se ejecutó. Verifica el estado de tu tabla con `DESCRIBE clientAccounts`.

### Error: Cannot add foreign key constraint
La tabla `categories` no existe. Comenta la línea de foreign key en el SQL o crea la tabla de categorías primero.

### Los datos no se migraron correctamente
Ejecuta manualmente:
```sql
UPDATE clientAccounts 
SET name = COALESCE(commercialName, 'Sin nombre')
WHERE name IS NULL OR name = '';
```

## Rollback (Revertir Cambios)

Si algo sale mal, puedes revertir los cambios:

```sql
-- Eliminar nuevas columnas
ALTER TABLE `clientAccounts` 
DROP COLUMN `name`,
DROP COLUMN `website`,
DROP COLUMN `categoryId`;

-- Restaurar longitudes originales
ALTER TABLE `clientAccounts` 
MODIFY COLUMN `phoneNumber` VARCHAR(10) NOT NULL,
MODIFY COLUMN `faxNumber` VARCHAR(10);
```

## Notas

- La migración es **segura** y no elimina datos automáticamente
- Las columnas antiguas se mantienen hasta que las elimines manualmente
- Puedes ejecutar la migración múltiples veces sin problemas (es idempotente)
