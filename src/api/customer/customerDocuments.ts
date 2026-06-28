/**
 * Document Vault (Feature #20) for the Mi Seguridad client app.
 *   GET /api/customer/documents
 *
 * Auth = the customer JWT (currentUser.clientAccountId). Aggregates the client's
 * compliance documents into ONE flat list so the app can render a single "Bóveda
 * de documentos" screen:
 *
 *   1. CERTIFICATIONS — the tenant certifications the client is entitled to
 *      (the same set sign-in exposes as `certificationIds`; tenant-scoped, the CRM
 *      manages them). name = title, plus code, signed image/icon downloadUrl,
 *      acquisitionDate (issuedDate) + expirationDate (expiresDate).
 *   2. INSURANCE — the tenant's insurance policies (provider/policyNumber,
 *      validFrom→issuedDate, validUntil→expiresDate, signed document downloadUrl).
 *
 * NOTE on contracts/files attached directly to the clientAccount: the only file
 * relations on `clientAccount` are `logoUrl` and `placePictureUrl` (avatars, NOT
 * compliance docs), and there is no per-client contract/insurance attachment in
 * the schema. So the vault aggregates the two TENANT-level compliance sources the
 * client is entitled to view (certifications + insurance). If a per-client
 * contract relation is added later, push it into `rows` with type:'contract'.
 *
 * Each item:
 *   { id, type:'certification'|'insurance', name, code?, downloadUrl,
 *     issuedDate?, expiresDate?, daysToExpiry? }
 * Response: { rows, count }.
 *
 * Every source is best-effort (a failing query yields [] and never breaks the
 * call), mirroring customerAccountMe / customerAnalytics.
 */
import ApiResponseHandler from '../apiResponseHandler';
import Error401 from '../../errors/Error401';
import Error400 from '../../errors/Error400';
import FileRepository from '../../database/repositories/fileRepository';

const customerCtx = (req: any) => {
  const u = req.currentUser;
  if (!u) throw new Error401();
  const clientAccountId = u.clientAccountId;
  if (!clientAccountId) throw new Error400(req.language, 'auth.clientAccountNotFound');
  return {
    db: req.database,
    tenantId: u.tenantId || (req.currentTenant && req.currentTenant.id),
    clientAccountId,
  };
};

/** Whole days from now until `date` (UTC date math). null when no/invalid date. */
export function daysUntil(date: any): number | null {
  if (!date) return null;
  const d = new Date(String(date));
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86400000);
}

/** First signed downloadUrl from a fillDownloadUrl()'d file array, else null. */
function firstUrl(files: any[]): string | null {
  if (!Array.isArray(files) || !files.length) return null;
  for (const f of files) {
    const url = f?.downloadUrl || f?.publicUrl || f?.privateUrl || null;
    if (url) return url;
  }
  return null;
}

export default async (req: any, res: any) => {
  try {
    const { db, tenantId, clientAccountId } = customerCtx(req);
    void clientAccountId; // tenant-scoped sources; clientAccount auth-checked above
    const rows: any[] = [];

    // ── 1. Certifications (tenant-scoped compliance the client is entitled to) ──
    try {
      const certs = tenantId
        ? await db.certification.findAll({
            where: { tenantId, deletedAt: null },
            attributes: [
              'id', 'title', 'code', 'acquisitionDate', 'expirationDate',
              'imageUrl', 'iconUrl',
            ],
          })
        : [];
      const certTable = db.certification.getTableName();
      const certIds = certs.map((c: any) => String(c.id));
      // Batch-load signed image/icon files for ALL certs in two queries.
      let imageByCert = new Map<string, any[]>();
      let iconByCert = new Map<string, any[]>();
      if (certIds.length) {
        const group = async (column: string) => {
          const files = await db.file.findAll({
            where: { belongsTo: certTable, belongsToId: certIds, belongsToColumn: column, deletedAt: null },
          });
          const signed = await FileRepository.fillDownloadUrl(files);
          const map = new Map<string, any[]>();
          for (const f of signed || []) {
            const k = String(f.belongsToId);
            if (!map.has(k)) map.set(k, []);
            map.get(k)!.push(f);
          }
          return map;
        };
        [imageByCert, iconByCert] = await Promise.all([group('image'), group('icon')]);
      }
      for (const c of certs) {
        const cp = c.get ? c.get({ plain: true }) : c;
        const id = String(cp.id);
        const downloadUrl =
          firstUrl(imageByCert.get(id) || []) ||
          firstUrl(iconByCert.get(id) || []) ||
          cp.imageUrl ||
          cp.iconUrl ||
          null;
        rows.push({
          id: cp.id,
          type: 'certification',
          name: cp.title || cp.code || 'Certificación',
          code: cp.code || null,
          downloadUrl,
          issuedDate: cp.acquisitionDate || null,
          expiresDate: cp.expirationDate || null,
          daysToExpiry: daysUntil(cp.expirationDate),
        });
      }
    } catch (e: any) {
      console.warn('[customerDocuments] certifications failed:', e?.message || e);
    }

    // ── 2. Insurance policies (tenant-scoped compliance documents) ──────────────
    try {
      const policies = tenantId
        ? await db.insurance.findAll({
            where: { tenantId, deletedAt: null },
            attributes: ['id', 'provider', 'policyNumber', 'validFrom', 'validUntil'],
          })
        : [];
      const insTable = db.insurance.getTableName();
      const insIds = policies.map((p: any) => String(p.id));
      let docByIns = new Map<string, any[]>();
      if (insIds.length) {
        const files = await db.file.findAll({
          where: { belongsTo: insTable, belongsToId: insIds, belongsToColumn: 'document', deletedAt: null },
        });
        const signed = await FileRepository.fillDownloadUrl(files);
        for (const f of signed || []) {
          const k = String(f.belongsToId);
          if (!docByIns.has(k)) docByIns.set(k, []);
          docByIns.get(k)!.push(f);
        }
      }
      for (const p of policies) {
        const pp = p.get ? p.get({ plain: true }) : p;
        const id = String(pp.id);
        const name = [pp.provider, pp.policyNumber].filter(Boolean).join(' · ') || 'Póliza de seguro';
        rows.push({
          id: pp.id,
          type: 'insurance',
          name,
          code: pp.policyNumber || null,
          downloadUrl: firstUrl(docByIns.get(id) || []),
          issuedDate: pp.validFrom || null,
          expiresDate: pp.validUntil || null,
          daysToExpiry: daysUntil(pp.validUntil),
        });
      }
    } catch (e: any) {
      console.warn('[customerDocuments] insurance failed:', e?.message || e);
    }

    // Soonest-to-expire first (items without an expiry sink to the bottom).
    rows.sort((a, b) => {
      const da = a.daysToExpiry == null ? Infinity : a.daysToExpiry;
      const dbb = b.daysToExpiry == null ? Infinity : b.daysToExpiry;
      return da - dbb;
    });

    return ApiResponseHandler.success(req, res, { rows, count: rows.length });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
