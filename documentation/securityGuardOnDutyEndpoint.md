### GET /tenant/:tenantId/security-guard/:id/on-duty

Obtiene únicamente el estado de servicio (`isOnDuty`) de un guardia.

**Request:**
- URL params: `tenantId`, `id` (id del securityGuard)

**Response:**
```json
{
  "isOnDuty": true
}
```

**Notas:**
- Requiere permisos de lectura de guardias.

**Ejemplo de uso:**
```http
GET /tenant/123/security-guard/456/on-duty
```
### PATCH /tenant/:tenantId/security-guard/:id/on-duty

Permite actualizar únicamente el estado de servicio (`isOnDuty`) de un guardia, sin afectar otros campos.

**Request:**
- URL params: `tenantId`, `id` (id del securityGuard)
- Body (JSON):
```json
{
  "isOnDuty": true
}
```

**Response:**
- El objeto actualizado del guardia.

**Notas:**
- El campo `isOnDuty` debe ser booleano (`true` o `false`).
- Requiere permisos de edición de guardias.

**Ejemplo de uso:**
```http
PATCH /tenant/123/security-guard/456/on-duty
Content-Type: application/json

{
  "isOnDuty": false
}
```
