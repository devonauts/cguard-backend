/**
 * Resolves the concrete email addresses and phone numbers that should receive a
 * notification, given its template targeting:
 *   - role-targeted events  → every tenant user holding one of the target roles
 *   - SPECIFIC events        → the single recipientUserId (or explicit overrides)
 */

export interface ResolvedRecipients {
  emails: string[];
  phones: string[];
}

/** Roles that always receive role-targeted notifications, regardless of any
 *  post-site assignment scoping (they oversee the whole tenant). */
const SEE_ALL_ROLES = ['admin', 'superadmin', 'operationsManager'];

export async function resolveRecipients(
  db: any,
  tenantId: string,
  template: any,
  opts: {
    recipientUserId?: string;
    recipientEmail?: string;
    recipientPhone?: string;
    /**
     * When set, role-targeted recipients are narrowed to users assigned to this
     * post-site (businessInfo id) — except SEE_ALL roles and users with no
     * post-site assignment (treated as tenant-wide). Used to send attendance
     * exceptions only to the assigned supervisor(s).
     */
    assignedPostSiteId?: string;
  },
): Promise<ResolvedRecipients> {
  const emails = new Set<string>();
  const phones = new Set<string>();

  try {
    // SPECIFIC target (template.targetRoles === null): single recipient.
    if (template.targetRoles == null) {
      let email = opts.recipientEmail || null;
      let phone = opts.recipientPhone || null;
      if ((!email || !phone) && opts.recipientUserId && db?.user) {
        const u = await db.user.findByPk(opts.recipientUserId, {
          attributes: ['email', 'phoneNumber'],
        });
        if (u) {
          email = email || u.email || null;
          phone = phone || u.phoneNumber || null;
        }
      }
      if (email) emails.add(email);
      if (phone) phones.add(phone);
      return { emails: [...emails], phones: [...phones] };
    }

    // Role-targeted: collect everyone in the tenant holding a target role.
    const targetRoles = String(template.targetRoles)
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);

    const narrow = !!opts.assignedPostSiteId;
    const include: any[] = [
      { model: db.user, as: 'user', attributes: ['email', 'phoneNumber'] },
    ];
    if (narrow) {
      include.push({
        model: db.businessInfo,
        as: 'assignedPostSites',
        attributes: ['id'],
        through: { attributes: [] },
        required: false,
      });
    }

    const tenantUsers = await db.tenantUser.findAll({ where: { tenantId }, include });

    for (const tu of tenantUsers || []) {
      const roles = Array.isArray(tu.roles)
        ? tu.roles
        : typeof tu.roles === 'string'
          ? tu.roles.split(',').map((r: string) => r.trim())
          : [];
      if (!roles.some((r: string) => targetRoles.includes(r))) continue;

      // Narrow to assigned post-site (except see-all roles + unassigned users).
      if (narrow && !roles.some((r: string) => SEE_ALL_ROLES.includes(r))) {
        const assigned = tu.assignedPostSites || [];
        if (assigned.length > 0 && !assigned.some((p: any) => p.id === opts.assignedPostSiteId)) {
          continue;
        }
      }

      const u = tu.user;
      if (u?.email) emails.add(u.email);
      if (u?.phoneNumber) phones.add(u.phoneNumber);
    }
  } catch (err) {
    console.warn('[notificationRecipients] resolve failed:', (err as any)?.message || err);
  }

  return { emails: [...emails], phones: [...phones] };
}
