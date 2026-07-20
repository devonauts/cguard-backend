/**
 * Client-app incident reporting (Mi Seguridad). Auth = the customer JWT
 * (currentUser.clientAccountId). The customer reports an incident at one of THEIR
 * stations, optionally attaching photos, and it lands in the CRM incident inbox
 * scoped to the client (incident.callerType = 'client').
 *
 *   POST /customer/incidents   create an incident (+ photos) → CRM + guard push
 *   GET  /customer/incidents   the client's own incidents (scoped)
 *
 * PHOTO INPUT — two shapes are accepted (pick whichever the client app sends):
 *   1. multipart/form-data with one or more `file` fields (binary upload). The
 *      route applies `multer().array('file')` → req.files. This is the cleaner
 *      primary path (mirrors customerProfilePicture.ts).
 *   2. JSON body `photos: [{ url | downloadUrl }]` — already-uploaded URLs. These
 *      are recorded as file rows pointing at the given URL (privateUrl), so the
 *      CRM gallery (incident.imageUrl hasMany file) shows them too.
 *
 * Push/CRM-notify is ALWAYS best-effort (try/catch) so a notify failure never
 * fails the create.
 */
import fs from 'fs';
import businessNameOf, { CLIENT_LABEL_ATTRIBUTES } from '../../services/clientDisplayName';
import os from 'os';
import path from 'path';
import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import FileStorage from '../../services/file/fileStorage';
import FileRepository from '../../database/repositories/fileRepository';
import { dispatch } from '../../lib/notificationDispatcher';
import { stationGuardUserIds } from '../../services/taskNotify';
import { pushToUser } from '../../services/pushService';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    userId: u.id,
    clientAccountId,
  };
};

/**
 * The set of stationIds the customer is allowed to touch. Mirrors
 * customerSafety.ts resolveCustomerStations: stations directly owned via
 * station.stationOriginId OR under the customer's post-sites
 * (businessInfo.clientAccountId → station.postSiteId).
 */
async function resolveCustomerStations(db: any, tenantId: string, clientAccountId: string) {
  const stationIds = new Set<string>();
  const [originStations, postSites] = await Promise.all([
    db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), stationOriginId: clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
    db.businessInfo.findAll({
      where: { ...(tenantId ? { tenantId } : {}), clientAccountId, deletedAt: null },
      attributes: ['id'],
    }),
  ]);
  for (const s of originStations || []) stationIds.add(String(s.id));

  const postSiteIds = (postSites || []).map((b: any) => String(b.id));
  if (postSiteIds.length) {
    const psStations = await db.station.findAll({
      where: { ...(tenantId ? { tenantId } : {}), postSiteId: { [Op.in]: postSiteIds }, deletedAt: null },
      attributes: ['id'],
    });
    for (const s of psStations || []) stationIds.add(String(s.id));
  }

  const ids = Array.from(stationIds);
  const stations = ids.length
    ? await db.station.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'stationName', 'postSiteId'],
      })
    : [];
  return { stationIds: ids, stations };
}

/**
 * Persists an uploaded binary via the active FileStorage provider, replicating
 * the local-storage fallback used by customerProfilePicture.ts (GCP/AWS providers
 * do not expose `upload`).
 */
async function storeBinary(buffer: Buffer, originalname: string, privateUrl: string) {
  const safeName = String(originalname || 'upload').replace(/[^A-Za-z0-9._-]/g, '_');
  const tempPath = path.join(
    os.tmpdir(),
    `customer-incident-${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`,
  );
  // Async write — these buffers are multi-MB phone photos; writeFileSync here
  // would block the event loop for every other request on the instance.
  await fs.promises.writeFile(tempPath, buffer);
  try {
    if (typeof (FileStorage as any).upload === 'function') {
      await (FileStorage as any).upload(tempPath, privateUrl);
    } else {
      const LocalStorage = require('../../services/file/localhostFileStorage').default;
      await LocalStorage.upload(tempPath, privateUrl);
    }
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer/incidents
// ─────────────────────────────────────────────────────────────────────────────
export const customerIncidentCreate = async (req: any, res: any) => {
  try {
    const { db, tenantId, userId, clientAccountId } = customerCtx(req);
    const b = req.body?.data || req.body || {};
    const title = String(b.title || '').trim();
    const description = String(b.description || '').trim();
    if (!title) throw new Error('Título requerido (title)');
    if (!description) throw new Error('Descripción requerida (description)');

    const { stationIds, stations } = await resolveCustomerStations(db, tenantId, clientAccountId);
    const stationById = new Map<string, any>(stations.map((s: any) => [String(s.id), s]));

    // Resolve the target station: explicit stationId (must belong to the customer),
    // else a station under the explicit postSiteId, else the customer's first
    // station, else null (station-less; the CRM can assign one).
    let stationId: string | null = null;
    if (b.stationId && stationById.has(String(b.stationId))) {
      stationId = String(b.stationId);
    } else if (b.postSiteId) {
      const match = stations.find((s: any) => String(s.postSiteId) === String(b.postSiteId));
      if (match) stationId = String(match.id);
    }
    if (!stationId && stationIds.length) stationId = stationIds[0];

    const station = stationId ? stationById.get(stationId) : null;
    const stationName = (station && station.stationName) || 'el puesto';
    const postSiteId: string | null = station ? (station.postSiteId || null) : null;

    // Client display name (for callerName).
    let clientName = 'el cliente';
    try {
      const ca = await db.clientAccount.findByPk(clientAccountId, { attributes: CLIENT_LABEL_ATTRIBUTES });
      // Un SOS/incidente llega rotulado "Cliente: X" al CRM y al vigilante — X debe
      // ser la empresa, que es como el operador reconoce de dónde viene la alerta.
      if (ca) clientName = businessNameOf(ca) || clientName;
    } catch { /* non-fatal */ }

    // incident model: status enum is abierto|cerrado → 'abierto'; priority is a free
    // STRING. No clientAccountId column → the FK is `clientId`. date/title/description
    // are NOT NULL. Photos attach as `imageUrl` file rows (hasMany).
    const priority = ['alta', 'media', 'baja'].includes(b.priority) ? b.priority : 'media';
    const incident = await db.incident.create({
      date: new Date(),
      title,
      description,
      priority,
      status: 'abierto',
      callerName: clientName,
      callerType: 'client',
      clientId: clientAccountId,
      stationId,
      postSiteId,
      wasRead: false,
      tenantId,
      createdById: userId,
      updatedById: userId,
    });
    const incidentId = String(incident.id);

    // ── Attach photos (best-effort each; never fail the create on one bad photo).
    const belongsTo = db.incident.getTableName();
    const belongsToColumn = 'imageUrl';
    let photoCount = 0;

    // 1. Binary uploads (multipart `file`).
    const files: any[] = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    for (const f of files) {
      if (!f || !f.buffer || !f.buffer.length) continue;
      try {
        const originalname = String(f.originalname || 'incident-photo');
        const privateUrl =
          `tenant/${tenantId}/incident/imageUrl/${incidentId}/${Date.now()}-${originalname}`
            .replace(/[^A-Za-z0-9._/-]/g, '_');
        await storeBinary(f.buffer, originalname, privateUrl);
        await db.file.create({
          belongsTo,
          belongsToId: incidentId,
          belongsToColumn,
          name: originalname,
          privateUrl,
          sizeInBytes: f.size || f.buffer.length,
          mimeType: f.mimetype || null,
          tenantId,
          createdById: userId || null,
          updatedById: userId || null,
        });
        photoCount += 1;
      } catch { /* skip the bad photo, keep the incident */ }
    }

    // 2. Already-uploaded URLs (photos: [{ url | downloadUrl }]).
    let photos = b.photos;
    if (typeof photos === 'string') {
      try { photos = JSON.parse(photos); } catch { photos = []; }
    }
    if (Array.isArray(photos)) {
      for (const p of photos) {
        const url = p && (p.url || p.downloadUrl || (typeof p === 'string' ? p : null));
        if (!url) continue;
        try {
          await db.file.create({
            belongsTo,
            belongsToId: incidentId,
            belongsToColumn,
            name: String(url).split('/').pop() || 'photo',
            privateUrl: String(url),
            tenantId,
            createdById: userId || null,
            updatedById: userId || null,
          });
          photoCount += 1;
        } catch { /* skip */ }
      }
    }

    // ── CRM notify (same channel the CRM uses for new incidents). Best-effort.
    try {
      dispatch(
        'incident.created',
        { incidentTitle: title, description, guardName: null, siteName: stationName },
        {
          database: db,
          tenantId,
          sourceEntityType: 'incident',
          sourceEntityId: incidentId,
          ...(postSiteId ? { assignedPostSiteId: postSiteId } : {}),
        },
      ).catch(() => undefined);
    } catch { /* never fail the request on notify */ }

    // ── Guard push (best-effort).
    (async () => {
      try {
        const guardIds = stationId ? await stationGuardUserIds(db, tenantId, stationId) : [];
        await Promise.all(
          guardIds.map((uid) =>
            pushToUser(db, tenantId, uid, {
              title: '🚨 Incidente reportado por el cliente',
              body: `${stationName} — ${title}`,
              data: { type: 'incident_reported', incidentId, stationId: String(stationId || '') },
            }).catch(() => undefined),
          ),
        );
      } catch { /* non-fatal */ }
    })();

    return ApiResponseHandler.success(req, res, { success: true, incidentId, photoCount });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer/incidents
// ─────────────────────────────────────────────────────────────────────────────
export const customerIncidentList = async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    const limit = Math.min(parseInt((req.query || {}).limit, 10) || 100, 200);

    const { stationIds } = await resolveCustomerStations(db, tenantId, clientAccountId);

    // The client's incidents = those tied directly to the clientAccount (clientId)
    // OR raised at one of the client's stations.
    const orClauses: any[] = [{ clientId: clientAccountId }];
    if (stationIds.length) orClauses.push({ stationId: { [Op.in]: stationIds } });

    const rows = await db.incident.findAll({
      where: { ...(tenantId ? { tenantId } : {}), deletedAt: null, [Op.or]: orClauses },
      include: [
        { model: db.station, as: 'station', attributes: ['id', 'stationName'] },
        { model: db.file, as: 'imageUrl', required: false },
      ],
      order: [['date', 'DESC']],
      limit,
    });

    const out = await Promise.all(
      (rows || []).map(async (r: any) => {
        const plain = r.get({ plain: true });
        let photos: any[] = [];
        try {
          const withUrls = await FileRepository.fillDownloadUrl(plain.imageUrl || []);
          photos = (withUrls || []).map((f: any) => ({ id: f.id, downloadUrl: f.downloadUrl || null, name: f.name || null }));
        } catch { photos = []; }
        return {
          id: plain.id,
          title: plain.title,
          description: plain.description,
          // Worker's narrative/observations (guard fills `content`) + actions taken — the
          // proof-of-patrol text the client needs alongside the photo.
          observations: (plain.content && String(plain.content).trim()) || null,
          actionsTaken: (plain.actionsTaken && String(plain.actionsTaken).trim()) || null,
          priority: plain.priority || null,
          status: plain.status || null,
          date: plain.date || null,
          stationId: plain.stationId || null,
          stationName: plain.station ? plain.station.stationName : null,
          callerType: plain.callerType || null,
          photos,
          imageUrl: photos.map((f: any) => ({ downloadUrl: f.downloadUrl })),
        };
      }),
    );

    return ApiResponseHandler.success(req, res, { rows: out, count: out.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
