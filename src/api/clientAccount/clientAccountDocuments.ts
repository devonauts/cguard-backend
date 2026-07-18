import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import assertClientAccess from '../../services/user/assertClientAccess';
import FileRepository from '../../database/repositories/fileRepository';

/**
 * Client "Documentos" library. Documents are real `attachment` rows stored with
 * notableType='clientAccount'. Returns the paginated/filterable list plus KPIs,
 * storage breakdown (by mime class), category counts and recent activity — all
 * from real data. No fabricated versioning/approval/signature workflow.
 */

const typeOfName = (name: string, mime?: string | null): string => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'PDF';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'Excel';
  if (['docx', 'doc'].includes(ext)) return 'Word';
  if (['pptx', 'ppt'].includes(ext)) return 'PowerPoint';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || (mime || '').startsWith('image/')) return 'Imagen';
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext) || (mime || '').startsWith('video/')) return 'Video';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'Comprimido';
  if (['txt', 'md', 'rtf'].includes(ext)) return 'Texto';
  return ext ? ext.toUpperCase() : 'Archivo';
};
const mimeClass = (name: string, mime?: string | null): 'documents' | 'images' | 'videos' | 'others' => {
  const t = typeOfName(name, mime);
  if (t === 'Imagen') return 'images';
  if (t === 'Video') return 'videos';
  if (['PDF', 'Excel', 'Word', 'PowerPoint', 'Texto'].includes(t)) return 'documents';
  return 'others';
};
const humanSize = (b: number) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${Math.round((b / Math.pow(1024, i)) * 10) / 10} ${u[i]}`;
};

export default async (req, res) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.attachmentRead);
    await assertClientAccess(req, req.params.id);

    const db = req.database;
    const tenantId = req.currentTenant && req.currentTenant.id;
    const clientAccountId = req.params.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const rows = await db.attachment.findAll({
      where: { tenantId, notableType: 'clientAccount', notableId: clientAccountId },
      include: [{ model: db.user, as: 'createdBy', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
      order: [['createdAt', 'DESC']],
      limit: 5000,
    }).catch(() => []);

    // Stable folio by creation order (ascending).
    const asc = [...rows].sort((a: any, b: any) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const folioById = new Map<string, string>();
    asc.forEach((r: any, i: number) => folioById.set(String(r.id), `DOC-${String(i + 1).padStart(5, '0')}`));

    const uploaderName = (u: any) => u ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || '—') : '—';

    const docs = rows.map((r: any) => {
      const name = r.name || 'Documento';
      return {
        id: String(r.id),
        code: folioById.get(String(r.id)) || 'DOC',
        name,
        category: r.category || 'Sin categoría',
        type: typeOfName(name, r.mimeType),
        cls: mimeClass(name, r.mimeType),
        sizeInBytes: Number(r.sizeInBytes) || 0,
        sizeLabel: humanSize(Number(r.sizeInBytes) || 0),
        uploadedBy: uploaderName(r.createdBy),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : now.toISOString(),
      };
    });

    // KPIs + breakdown + categories + activity (over the full set).
    const total = docs.length;
    const uploadedThisMonth = docs.filter((d) => new Date(d.createdAt) >= monthStart).length;
    const storageUsedBytes = docs.reduce((a, d) => a + d.sizeInBytes, 0);
    const breakdown = { documents: 0, images: 0, videos: 0, others: 0 };
    for (const d of docs) breakdown[d.cls] += d.sizeInBytes;
    const catMap = new Map<string, number>();
    for (const d of docs) catMap.set(d.category, (catMap.get(d.category) || 0) + 1);
    const categories = [...catMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const recentActivity = docs.slice(0, 6).map((d) => ({ id: d.id, name: d.name, user: d.uploadedBy, at: d.createdAt, action: 'Subió' }));
    const types = [...new Set(docs.map((d) => d.type))].sort();

    // Filters + pagination.
    const q = String(req.query.q || '').trim().toLowerCase();
    const fCat = String(req.query.category || '');
    const fType = String(req.query.type || '');
    let filtered = docs;
    if (q) filtered = filtered.filter((d) => d.name.toLowerCase().includes(q) || d.code.toLowerCase().includes(q) || d.category.toLowerCase().includes(q) || d.type.toLowerCase().includes(q));
    if (fCat) filtered = filtered.filter((d) => d.category === fCat);
    if (fType) filtered = filtered.filter((d) => d.type === fType);

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const perPage = Math.min(50, Math.max(5, parseInt(String(req.query.perPage || '10'), 10) || 10));
    const totalFiltered = filtered.length;
    const pageSlice = filtered.slice((page - 1) * perPage, page * perPage);

    // Sign download URLs only for the visible page.
    const pageIds = new Set(pageSlice.map((d) => d.id));
    const pageRows = rows.filter((r: any) => pageIds.has(String(r.id)));
    let signed: any[] = [];
    try { signed = await FileRepository.fillDownloadUrl(pageRows); } catch { signed = []; }
    const urlById = new Map<string, string>(signed.map((s: any) => [String(s.id), s.downloadUrl]));
    const pageItems = pageSlice.map((d) => ({ ...d, downloadUrl: urlById.get(d.id) || null }));

    // Soft storage cap for the progress bar (real usage; cap is informational).
    const capBytes = 100 * 1024 * 1024 * 1024; // 100 GB soft reference

    return ApiResponseHandler.success(req, res, {
      kpis: {
        total, uploadedThisMonth, categoriesCount: categories.length,
        storageUsedBytes, storageUsedLabel: humanSize(storageUsedBytes),
        capBytes, capLabel: '100 GB', usedPct: Math.min(100, Math.round((storageUsedBytes / capBytes) * 100)),
      },
      breakdown: {
        documents: { bytes: breakdown.documents, label: humanSize(breakdown.documents) },
        images: { bytes: breakdown.images, label: humanSize(breakdown.images) },
        videos: { bytes: breakdown.videos, label: humanSize(breakdown.videos) },
        others: { bytes: breakdown.others, label: humanSize(breakdown.others) },
      },
      categories, recentActivity, types,
      total: totalFiltered, page, perPage,
      documents: pageItems,
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
