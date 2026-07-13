/**
 * Department-manager routing (Settings › Departamentos).
 *
 * Resolves the user id of the ACTIVE manager (responsable) of the department a
 * given member belongs to, so tenant-wide notifications (e.g. time-off
 * requests) can be routed to that one person instead of the whole HR/admin
 * role group. Returns null — meaning "fall back to role-group targeting" —
 * when the member has no department, the department is inactive or has no
 * manager, the manager IS the requester, or the manager is no longer an
 * active member of the tenant.
 */
export async function resolveDepartmentManagerUserId(
  db: any,
  tenantId: string,
  memberUserId: string,
): Promise<string | null> {
  if (!db?.tenantUser || !db?.department || !tenantId || !memberUserId) return null;
  try {
    const membership = await db.tenantUser.findOne({
      where: { tenantId, userId: memberUserId },
      attributes: ['departmentId'],
    });
    if (!membership?.departmentId) return null;

    const dept = await db.department.findOne({
      where: { id: membership.departmentId, tenantId, active: true },
      attributes: ['managerId'],
    });
    const managerId = dept?.managerId || null;
    if (!managerId || String(managerId) === String(memberUserId)) return null;

    const managerMembership = await db.tenantUser.findOne({
      where: { tenantId, userId: managerId, status: 'active' },
      attributes: ['id'],
    });
    return managerMembership ? String(managerId) : null;
  } catch (err) {
    console.warn('[departmentRouting] resolve failed:', (err as any)?.message || err);
    return null;
  }
}

export default { resolveDepartmentManagerUserId };
