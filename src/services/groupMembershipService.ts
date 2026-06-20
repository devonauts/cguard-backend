/**
 * Group membership derivation + sync.
 *
 * A group conversation (kind='group') is anchored to a post site or station.
 * Its guard members are derived from the assignment data (the single source of
 * truth: guardAssignment → generated shifts), the same source the CRM's
 * "guards assigned to a post site" view reads. `source='auto'` participant rows
 * mirror that derived set; `source='manual'` rows (and staff) are left untouched.
 *
 * Tenant isolation is manual: every query filters tenantId.
 */

type AnchorType = 'postSite' | 'station';

/**
 * Resolve the set of guard user ids assigned to an anchor (post site or station).
 * The :anchorId is matched against both shifts and active guardAssignments,
 * covering postSiteId / stationId links on either table (mirrors
 * api/postSite/postSiteAssignedGuards.ts).
 */
export async function resolveAnchorGuardUserIds(
  db: any,
  tenantId: string,
  _anchorType: AnchorType | string | null,
  anchorId: string,
): Promise<string[]> {
  if (!anchorId) return [];
  const sql = `
    SELECT DISTINCT userId FROM (
      SELECT s.guardId AS userId
      FROM shifts s
      LEFT JOIN stations st ON st.id = s.stationId
      WHERE s.tenantId = :tenantId AND s.guardId IS NOT NULL
        AND (s.postSiteId = :anchorId OR s.stationId = :anchorId OR st.id = :anchorId OR st.postSiteId = :anchorId)
      UNION
      SELECT ga.guardId AS userId
      FROM guardAssignments ga
      LEFT JOIN stations st2 ON st2.id = ga.stationId
      WHERE ga.tenantId = :tenantId AND ga.guardId IS NOT NULL
        AND ga.status = 'active'
        AND (ga.startDate IS NULL OR ga.startDate <= CURDATE())
        AND (ga.endDate IS NULL OR ga.endDate >= CURDATE())
        AND (ga.stationId = :anchorId OR st2.id = :anchorId OR st2.postSiteId = :anchorId)
    ) AS u
  `;
  try {
    const rows: any[] = await db.sequelize.query(sql, {
      replacements: { tenantId, anchorId },
      type: db.sequelize.QueryTypes.SELECT,
    });
    return Array.from(new Set((rows || []).map((r) => String(r.userId)).filter(Boolean)));
  } catch (e: any) {
    console.warn('[groupMembership] resolve failed:', e?.message || e);
    return [];
  }
}

/** Map guard user ids → their securityGuard record (id + name) for this tenant. */
async function guardRecordsByUserId(db: any, tenantId: string, userIds: string[]): Promise<Map<string, { id: string; fullName: string }>> {
  const out = new Map<string, { id: string; fullName: string }>();
  if (!userIds.length) return out;
  const { Op } = db.Sequelize;
  const sgs = await db.securityGuard.findAll({
    where: { tenantId, guardId: { [Op.in]: userIds }, deletedAt: null },
    attributes: ['id', 'guardId', 'fullName'],
  });
  for (const sg of sgs) out.set(String(sg.guardId), { id: sg.id, fullName: sg.fullName || 'Guardia' });
  return out;
}

/**
 * Ensure a single participant row exists (restoring a soft-deleted one rather
 * than duplicating). Never throws — returns the row or null.
 */
export async function upsertParticipant(
  db: any,
  tenantId: string,
  conversationId: string,
  userId: string,
  fields: { participantType?: string; role?: string; source?: string; securityGuardId?: string | null; actorId?: string | null },
): Promise<any> {
  // Look across soft-deleted rows too (paranoid:false) to avoid duplicates.
  const existing = await db.messageConversationParticipant.findOne({
    where: { tenantId, conversationId, userId },
    paranoid: false,
  });
  if (existing) {
    const patch: any = {};
    if (existing.deletedAt) patch.deletedAt = null; // restore
    if (fields.participantType && existing.participantType !== fields.participantType) patch.participantType = fields.participantType;
    if (fields.role && existing.role !== fields.role) patch.role = fields.role;
    if (fields.securityGuardId && !existing.securityGuardId) patch.securityGuardId = fields.securityGuardId;
    // Never downgrade a manual member back to auto.
    if (fields.source && existing.source !== 'manual' && fields.source !== existing.source) patch.source = fields.source;
    if (Object.keys(patch).length) { patch.updatedById = fields.actorId || null; await existing.update(patch); }
    return existing;
  }
  return db.messageConversationParticipant.create({
    tenantId,
    conversationId,
    userId,
    participantType: fields.participantType || 'guard',
    role: fields.role || 'member',
    source: fields.source || 'manual',
    securityGuardId: fields.securityGuardId || null,
    createdById: fields.actorId || null,
    updatedById: fields.actorId || null,
  });
}

/**
 * Re-derive a group's `auto` guard membership from its anchor. Adds newly
 * assigned guards, deactivates auto rows no longer assigned. Manual rows and
 * staff are never touched. Idempotent. Returns the resolved guard user ids.
 */
export async function syncGroupMembership(db: any, conversationId: string, tenantId: string): Promise<string[]> {
  const convo = await db.messageConversation.findOne({ where: { id: conversationId, tenantId, deletedAt: null } });
  if (!convo || convo.kind !== 'group' || !convo.anchorId) return [];

  const resolved = await resolveAnchorGuardUserIds(db, tenantId, convo.anchorType, convo.anchorId);
  const resolvedSet = new Set(resolved);
  const sgMap = await guardRecordsByUserId(db, tenantId, resolved);

  // Add / restore auto members.
  for (const userId of resolved) {
    const sg = sgMap.get(userId);
    await upsertParticipant(db, tenantId, conversationId, userId, {
      participantType: 'guard', role: 'member', source: 'auto',
      securityGuardId: sg?.id || null, actorId: convo.createdById,
    });
  }

  // Deactivate auto rows whose guard is no longer assigned.
  const currentAuto = await db.messageConversationParticipant.findAll({
    where: { tenantId, conversationId, source: 'auto', deletedAt: null },
    attributes: ['id', 'userId'],
  });
  for (const p of currentAuto) {
    if (!resolvedSet.has(String(p.userId))) await p.destroy();
  }

  await convo.update({ groupSyncedAt: new Date() });
  return resolved;
}

/** Determine whether a user is a guard (has a securityGuard record) or staff. */
export async function classifyMember(db: any, tenantId: string, userId: string): Promise<{ participantType: 'staff' | 'guard'; securityGuardId: string | null }> {
  const sg = await db.securityGuard.findOne({ where: { tenantId, guardId: userId, deletedAt: null }, attributes: ['id'] });
  return sg ? { participantType: 'guard', securityGuardId: sg.id } : { participantType: 'staff', securityGuardId: null };
}

/** List a group's active participants with display names. */
export async function listParticipants(db: any, tenantId: string, conversationId: string): Promise<any[]> {
  const rows = await db.messageConversationParticipant.findAll({
    where: { tenantId, conversationId, deletedAt: null },
    include: [{ model: db.user, as: 'user', attributes: ['id', 'fullName', 'firstName', 'lastName'], required: false }],
    order: [['participantType', 'ASC'], ['createdAt', 'ASC']],
  });
  return rows.map((p: any) => {
    const o = p.get({ plain: true });
    const name = p.user?.fullName || [p.user?.firstName, p.user?.lastName].filter(Boolean).join(' ') || (o.participantType === 'staff' ? 'Operador' : 'Guardia');
    return { id: o.id, userId: o.userId, name, participantType: o.participantType, role: o.role, source: o.source };
  });
}
