/**
 * SuperAdmin · app-feedback service. Lists C-Guard Pro experience ratings
 * (appFeedback) across ALL tenants + a summary (avg + distribution).
 */
import { Request } from 'express';
import { db, listParams } from './superadminHelpers';

export async function listFeedback(req: Request): Promise<any> {
  const database = db(req);
  const Op = database.Sequelize.Op;
  const { page, limit, offset, search } = listParams(req.query);

  const where: any = {};
  const ratingFilter = req.query.rating ? parseInt(String(req.query.rating), 10) : null;
  if (ratingFilter && ratingFilter >= 1 && ratingFilter <= 5) where.rating = ratingFilter;
  if (req.query.source) where.source = String(req.query.source);
  if (search) where.comment = { [Op.like]: `%${search}%` };

  const { rows, count } = await database.appFeedback.findAndCountAll({
    where,
    include: [
      { model: database.tenant, as: 'tenant', attributes: ['id', 'name'], required: false },
      { model: database.user, as: 'user', attributes: ['id', 'firstName', 'lastName', 'fullName', 'email'], required: false },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  // Summary across ALL feedback (not just the current page).
  const all = await database.appFeedback.findAll({ attributes: ['rating'] });
  const total = all.length;
  const sum = all.reduce((s: number, r: any) => s + (r.rating || 0), 0);
  const avg = total ? sum / total : 0;
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of all) if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++;

  const shaped = rows.map((r: any) => {
    const o = r.get ? r.get({ plain: true }) : r;
    const u = o.user;
    return {
      id: String(o.id),
      rating: o.rating,
      comment: o.comment || null,
      source: o.source || 'crm',
      createdAt: o.createdAt,
      tenant: o.tenant ? { id: String(o.tenant.id), name: o.tenant.name } : null,
      user: u ? { id: String(u.id), name: u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email, email: u.email } : null,
    };
  });

  return {
    rows: shaped,
    count,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(count / limit)),
    summary: { total, avg: Math.round(avg * 10) / 10, distribution },
  };
}
