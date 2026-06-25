# Integrar Mensajería en la app de clientes (Mi Seguridad)

Guía para conectar la app de clientes al backend de C‑Guard Pro. El contrato
completo está en [`customer-messaging.openapi.yaml`](./customer-messaging.openapi.yaml)
(impórtalo en Postman/Swagger). Las mismas conversaciones aparecen en el CRM bajo
**Mensajería › Mensajes de Clientes**.

## Resumen del flujo
- **Base URL:** `https://api.cguardpro.com/api`
- **Auth:** `POST /auth/sign-in-customer` → `{ token }`. Guarda el token y mándalo
  como `Authorization: Bearer <token>` en todo lo demás. El token ya trae
  `tenantId` + `clientAccountId`, así que las rutas `/customer/*` no llevan tenant.
- **Un cliente tiene UN solo hilo con la oficina** (se reutiliza). El primer
  mensaje lo crea con `POST /customer/messages`.
- **Respuestas sin envoltura**: el body 200 es el objeto que documenta el YAML.

## Endpoints que usa la app
| Acción | Método y ruta | Body |
|---|---|---|
| Login | `POST /auth/sign-in-customer` | `{ email, password }` |
| Listar conversaciones | `GET /customer/messages?limit&cursor` | — |
| **Iniciar** conversación | `POST /customer/messages` | `{ body, subject?, clientMsgId, attachments? }` |
| Ver hilo | `GET /customer/messages/{id}?limit&before` | — |
| Responder | `POST /customer/messages/{id}` | `{ body, clientMsgId, attachments? }` |
| Marcar leído | `POST /customer/messages/{id}/read` | `{}` |
| Registrar push | `POST /customer/me/device-id-information` | `{ deviceId, platform, model?, osVersion?, appVersion? }` |
| Subir adjunto (paso 1) | `GET /tenant/{tenantId}/file/credentials?storageId=messageAttachments&filename=<uuid>.jpg` | — |

## Reglas de integración (importantes)
1. **Idempotencia:** genera un `clientMsgId` (UUID v4) por mensaje y reenvíalo en
   reintentos — el backend devuelve el mismo mensaje, no duplica.
2. **Orden del hilo:** `rows` viene **del más nuevo al más viejo** → invierte para
   mostrar. Para cargar más viejos, manda `before=<createdAt del más viejo>`.
3. **Paginación de la lista:** usa `nextCursor` como `cursor` para la siguiente página.
4. **Solo lectura:** si `conversation.isOneWay` es `true`, oculta el campo de
   respuesta (el backend rechaza con 400).
5. **Realtime:** NO hay websocket. Usa **FCM push** (el payload trae
   `conversationId` → deep‑link al hilo) + **polling** de la lista cada ~12 s y
   refresco del hilo abierto.
6. **Vacío:** un mensaje debe llevar texto y/o al menos un adjunto.

## Adjuntos (imágenes / video / nota de voz)
1. `GET /tenant/{tenantId}/file/credentials?storageId=messageAttachments&filename=<uuid>.<ext>`
   → `{ uploadCredentials: { url, fields }, downloadUrl }`.
2. Sube el archivo a `uploadCredentials.url` como `multipart/form-data`,
   incluyendo **primero** todos los `uploadCredentials.fields` y al final el campo
   `file` con el binario (estilo presigned‑POST).
3. Envía el mensaje con `attachments: [{ url: downloadUrl, type: "image"|"video"|"audio", name, sizeInBytes }]`.
   Máx **10** adjuntos por mensaje, **100 MB** c/u.
> Referencia de implementación: en el CRM, `frontend/src/lib/api/messageService.ts`
> → `uploadAttachment()` hace exactamente estos 3 pasos.

## Push (FCM)
- Mismo proyecto Firebase que la worker app (`cguardpro-worker-app`).
- Tras el login (y al refrescar el token), llama `POST /customer/me/device-id-information`
  con `{ deviceId: <FCM token>, platform }`. Sin esto, los avisos de mensajes
  nuevos no llegan.
- Al tocar la notificación, abre el hilo usando `payload.conversationId`.

---

## Prompt listo para Claude (pégalo en el repo de la app de clientes)

> Estoy integrando la API de mensajería de C‑Guard Pro en esta app de clientes.
> El contrato está en este OpenAPI: **<pega aquí el contenido de
> `customer-messaging.openapi.yaml`>**. Base URL `https://api.cguardpro.com/api`.
>
> Primero **detecta el stack de esta app** (React Native / Expo / Ionic‑Capacitor /
> nativo) y sigue sus convenciones existentes (cliente HTTP, almacenamiento del
> token, navegación). Luego implementa, reutilizando lo que ya exista:
>
> 1. **Auth:** función de login `POST /auth/sign-in-customer` que guarde `token`
>    de forma segura y un interceptor que agregue `Authorization: Bearer <token>`
>    a todas las llamadas. Maneja 401 → re‑login.
> 2. **Servicio `messagingApi`** con: `listConversations({limit,cursor})`,
>    `createConversation({body,subject?,clientMsgId,attachments?})`,
>    `getThread(id,{limit,before})`, `reply(id,{body,clientMsgId,attachments?})`,
>    `markRead(id)`, `registerPushToken({deviceId,platform,...})`,
>    `uploadAttachment(file)` (los 3 pasos de file/credentials → devuelve
>    `{url,type,name,sizeInBytes}`). Genera `clientMsgId` con UUID v4.
> 3. **Pantallas:** (a) lista de conversaciones con badge de `unreadCount` y
>    `lastMessagePreview`; (b) hilo de chat (invierte `rows`, burbujas por
>    `senderType`, muestra adjuntos imagen/video/audio, `markRead` al abrir,
>    `before` para cargar más viejos, oculta input si `isOneWay`); (c) botón
>    "Nuevo mensaje" → `createConversation`. Adjuntar foto/galería/nota de voz vía
>    `uploadAttachment`.
> 4. **Realtime:** polling de la lista cada 12 s + refresco del hilo abierto. Si la
>    app ya tiene FCM, registra el token con `registerPushToken` tras el login y
>    abre el hilo desde `payload.conversationId` al tocar la notificación.
>
> Respeta: respuestas sin envoltura (el body 200 es el objeto del YAML); `rows`
> newest‑first; idempotencia con `clientMsgId`; mensaje requiere texto y/o adjunto.
> No inventes endpoints fuera del OpenAPI. Sigue el estilo de código existente del
> repo (no agregues dependencias si ya hay equivalentes).
