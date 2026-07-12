/**
 * Backfill the `training*` permissions into every existing tenant's frozen role
 * snapshots. The Entrenamiento module shipped AFTER these tenants' roles were
 * seeded, so their non-empty DB `roles.permissions` snapshots (which win over the
 * static defaults — see memory rbac-new-permission-propagation) never got the
 * training grants. Symptom: CRM Capacitación → GET /training/courses = 403 for
 * admins who should have trainingCourseRead.
 *
 * Grants each training permission to the SAME role slugs the static map does.
 * Only ADDS to non-empty snapshots (empty snapshot = static defaults already
 * apply). Idempotent. Users must RE-LOGIN afterwards (effective set is baked at
 * sign-in). Run: npx ts-node scripts/20260712-backfill-training-permissions.ts
 */
require('dotenv').config();

import models from '../src/database/models';

// Role groups mirrored from src/security/permissions.ts.
const SUPERVISOR = ['admin', 'operationsManager', 'securitySupervisor'];
const MANAGEMENT = ['admin', 'operationsManager'];
const GUARD = ['admin', 'operationsManager', 'securitySupervisor', 'dispatcher', 'securityGuard'];

// permission → the role slugs that should carry it (per the static defaults).
const GRANTS: Record<string, string[]> = {
  trainingCourseCreate: SUPERVISOR,
  trainingCourseEdit: SUPERVISOR,
  trainingCourseDestroy: MANAGEMENT,
  trainingCourseRead: GUARD,
  trainingLessonCreate: SUPERVISOR,
  trainingLessonEdit: SUPERVISOR,
  trainingLessonDestroy: SUPERVISOR,
  trainingLessonRead: GUARD,
  trainingEnrollmentCreate: SUPERVISOR,
  trainingEnrollmentRead: GUARD,
  trainingLessonComplete: GUARD,
  trainingQuizAttempt: GUARD,
  trainingCertificateRead: GUARD,
};

async function run() {
  const db: any = models();
  const roles = await db.role.findAll();
  let rowsChanged = 0;
  let grantsAdded = 0;

  for (const role of roles) {
    // Parse the snapshot (array or JSON string).
    let perms: string[] = [];
    const raw = role.permissions;
    if (Array.isArray(raw)) perms = raw.slice();
    else if (typeof raw === 'string') { try { perms = JSON.parse(raw); } catch { perms = []; } }
    if (!Array.isArray(perms)) perms = [];
    if (perms.length === 0) continue; // empty snapshot → static defaults already include training

    const before = perms.length;
    for (const [perm, slugs] of Object.entries(GRANTS)) {
      if (slugs.includes(role.slug) && !perms.includes(perm)) perms.push(perm);
    }
    if (perms.length !== before) {
      grantsAdded += perms.length - before;
      await role.update({ permissions: perms });
      rowsChanged++;
      console.log(`  + ${perms.length - before} training perm(s) → role ${role.slug} (tenant ${role.tenantId})`);
    }
  }

  console.log(`Backfill complete: ${grantsAdded} grant(s) across ${rowsChanged} role row(s). Users must re-login.`);
  process.exit(0);
}

run().catch((e) => { console.error('Backfill failed:', e); process.exit(1); });
