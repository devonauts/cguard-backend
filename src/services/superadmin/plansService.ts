/**
 * SuperAdmin · plan catalog service — CRUD for the editable pricing/tier catalog
 * (planCatalogs). Routes in src/api/superadmin/plans.ts stay thin and delegate
 * here. Every mutation clears the planCatalogService cache so the resolver and
 * billing summary pick up changes immediately.
 */
import { Request } from 'express';
import { db } from './superadminHelpers';
import { FEATURES, sanitizeFeatures } from '../../lib/entitlements';
import { clearCache } from '../planCatalogService';
import Error404 from '../../errors/Error404';
import Error400 from '../../errors/Error400';

/** Fields a superadmin may set on a plan (allow-list). */
const WRITABLE = [
  'key',
  'name',
  'description',
  'monthlyPerSeatCents',
  'implementationCents',
  'seatCap',
  'features',
  'stripePriceId',
  'active',
  'isDefault',
  'sortOrder',
];

function pick(body: any): any {
  const out: any = {};
  for (const f of WRITABLE) {
    if (body && body[f] !== undefined) out[f] = body[f];
  }
  if (out.features !== undefined) out.features = sanitizeFeatures(out.features);
  // Coerce numeric-or-null fields.
  for (const n of ['monthlyPerSeatCents', 'implementationCents', 'seatCap', 'sortOrder']) {
    if (out[n] === '' || out[n] === null) out[n] = n === 'sortOrder' ? 0 : null;
    else if (out[n] !== undefined) out[n] = Number(out[n]);
  }
  return out;
}

/** GET /plans — all catalog rows (incl. inactive) + tenant counts per plan. */
export async function listPlans(req: Request): Promise<any> {
  const database = db(req);
  const rows = await database.planCatalog.findAll({ order: [['sortOrder', 'ASC']] });

  // Count tenants per plan key (one grouped query).
  const grouped = await database.tenant.findAll({
    attributes: [
      'plan',
      [database.Sequelize.fn('COUNT', database.Sequelize.col('id')), 'cnt'],
    ],
    group: ['plan'],
    raw: true,
  });
  const countByKey: Record<string, number> = {};
  for (const g of grouped as any[]) countByKey[g.plan] = Number(g.cnt) || 0;

  return {
    features: FEATURES, // registry so the editor can render checkboxes
    plans: rows.map((r: any) => {
      const p = r.get ? r.get({ plain: true }) : r;
      return { ...p, tenantCount: countByKey[p.key] || 0 };
    }),
  };
}

/** POST /plans — create a tier. Enforces unique key + single default. */
export async function createPlan(req: Request): Promise<any> {
  const database = db(req);
  const data = pick(req.body || {});
  if (!data.key || !data.name) {
    throw new Error400((req as any).language, undefined, 'key and name are required');
  }
  const existing = await database.planCatalog.findOne({ where: { key: data.key } });
  if (existing) {
    throw new Error400((req as any).language, undefined, `Plan key "${data.key}" already exists`);
  }
  if (data.features === undefined) data.features = [];
  const created = await database.planCatalog.create(data);
  if (data.isDefault) await unsetOtherDefaults(database, created.id);
  clearCache();
  return created.get ? created.get({ plain: true }) : created;
}

/** PUT /plans/:id — partial update. */
export async function updatePlan(req: Request, id: string): Promise<any> {
  const database = db(req);
  const plan = await database.planCatalog.findByPk(id);
  if (!plan) throw new Error404((req as any).language);
  const data = pick(req.body || {});
  // Prevent renaming a key to one that collides with another row.
  if (data.key && data.key !== plan.key) {
    const clash = await database.planCatalog.findOne({ where: { key: data.key } });
    if (clash) throw new Error400((req as any).language, undefined, `Plan key "${data.key}" already exists`);
  }
  await plan.update(data);
  if (data.isDefault) await unsetOtherDefaults(database, plan.id);
  clearCache();
  return plan.get ? plan.get({ plain: true }) : plan;
}

/** DELETE /plans/:id — soft-delete a tier. Blocks if tenants still use it. */
export async function deletePlan(req: Request, id: string): Promise<any> {
  const database = db(req);
  const plan = await database.planCatalog.findByPk(id);
  if (!plan) throw new Error404((req as any).language);
  const inUse = await database.tenant.count({ where: { plan: plan.key } });
  if (inUse > 0) {
    throw new Error400(
      (req as any).language,
      undefined,
      `No se puede eliminar: ${inUse} tenant(s) usan este plan. Reasígnalos primero.`,
    );
  }
  await plan.destroy();
  clearCache();
  return { success: true };
}

/** Ensure only one tier is the default. */
async function unsetOtherDefaults(database: any, keepId: string): Promise<void> {
  await database.planCatalog.update(
    { isDefault: false },
    { where: { id: { [database.Sequelize.Op.ne]: keepId } } },
  );
}
