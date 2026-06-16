/**
 * operationalRecipients — resolve the tenant user IDs that should receive an
 * OPERATIONAL alert (incident / visitor / ronda / no-show / escalation) through
 * the unified CommunicationService (push-first → WhatsApp → SMS).
 *
 * This is the CommunicationService counterpart to lib/notificationRecipients
 * (which returns emails/phones for the legacy dashboard/email dispatcher). The
 * existing notificationDispatcher.dispatch() still owns in-app + email + the
 * legacy SMS path; this helper only feeds the NEW push/WhatsApp routing so a
 * supervisor is also reached on their device. Best-effort — never throws.
 */

/** Roles that oversee the whole tenant and always receive operational alerts. */
const SUPERVISOR_ROLES = [
  'admin',
  'owner',
  'superadmin',
  'operationsManager',
  'securitySupervisor',
  'dispatcher',
];

/** Roles that see everything regardless of post-site assignment scoping. */
const SEE_ALL_ROLES = ['admin', 'owner', 'superadmin', 'operationsManager'];

function parseRoles(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(',').map((r) => r.trim()).filter(Boolean);
  return [];
}

/**
 * Active tenant user IDs holding a supervisor/admin role. When
 * `assignedPostSiteId` is given, role-targeted users are narrowed to those
 * assigned to that post-site (except see-all roles and users with no
 * assignment, who are treated as tenant-wide) — mirroring notificationRecipients.
 */
export async function resolveSupervisorUserIds(
  db: any,
  tenantId: string,
  opts: { assignedPostSiteId?: string | null } = {},
): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const narrow = !!opts.assignedPostSiteId;
    const include: any[] = [{ model: db.user, as: 'user', attributes: ['id'] }];
    if (narrow) {
      include.push({
        model: db.businessInfo,
        as: 'assignedPostSites',
        attributes: ['id'],
        through: { attributes: [] },
        required: false,
      });
    }

    const tenantUsers = await db.tenantUser.findAll({
      where: { tenantId, status: 'active' },
      include,
    });

    for (const tu of tenantUsers || []) {
      const roles = parseRoles(tu.roles);
      if (!roles.some((r) => SUPERVISOR_ROLES.includes(r))) continue;

      if (narrow && !roles.some((r) => SEE_ALL_ROLES.includes(r))) {
        const assigned = tu.assignedPostSites || [];
        if (
          assigned.length > 0 &&
          !assigned.some((p: any) => p.id === opts.assignedPostSiteId)
        ) {
          continue;
        }
      }

      const userId = tu.userId || (tu.user && tu.user.id) || null;
      if (userId) ids.add(String(userId));
    }
  } catch (e: any) {
    console.warn('[operationalRecipients] resolve failed:', e?.message || e);
  }
  return Array.from(ids);
}

export default { resolveSupervisorUserIds };
