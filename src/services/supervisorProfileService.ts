/**
 * Supervisor identity/HR management for the CRM — the supervisor mirror of the
 * securityGuard admin surface. A supervisor is a tenantUser with the
 * `securitySupervisor` role; this service manages their `supervisorProfile` row
 * (personal data, docs, zone/vehicle) and surfaces their LIVE clock status from
 * `supervisorShift` (de-islanding it for the CRM).
 *
 * Supervisors are NEVER given a securityGuard row or a stationAssignedGuardsUser
 * entry (audit safety rule — that would pollute guard queries).
 */
import { Request } from 'express';
import Error404 from '../errors/Error404';
import Error400 from '../errors/Error400';

const SUPERVISOR_ROLE = 'securitySupervisor';

/** Profile fields a CRM user may set (allow-list). */
const WRITABLE_PROFILE = [
  'governmentId', 'gender', 'bloodType', 'birthDate', 'birthPlace', 'maritalStatus',
  'academicInstruction', 'address', 'latitude', 'longitude', 'hiringContractDate',
  'guardCredentials', 'availability', 'languages', 'skills', 'zone', 'assignedVehicle',
  // Turno (Phase 2)
  'turnoDays', 'turnoStart', 'turnoEnd', 'mobileStationId',
];

function db(req: Request): any {
  return (req as any).database;
}
function tenantId(req: Request): string {
  return (req as any).currentTenant?.id;
}

function rolesOf(tu: any): string[] {
  const raw = tu?.roles;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return [raw]; } }
  return [];
}

/** All tenantUsers in this tenant that hold the supervisor role, with their user. */
async function supervisorMemberships(database: any, tid: string): Promise<any[]> {
  const rows = await database.tenantUser.findAll({
    where: { tenantId: tid },
    include: [{ model: database.user, as: 'user', attributes: ['id', 'firstName', 'lastName', 'fullName', 'email', 'phoneNumber'] }],
  });
  return rows.filter((tu: any) => rolesOf(tu).includes(SUPERVISOR_ROLE) && tu.user);
}

/** Find (or lazily create) the supervisorProfile row for a supervisor user. */
async function ensureProfile(database: any, tid: string, user: any, actorId?: string): Promise<any> {
  let profile = await database.supervisorProfile.findOne({ where: { tenantId: tid, supervisorUserId: user.id } });
  if (!profile) {
    const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || '';
    profile = await database.supervisorProfile.create({
      tenantId: tid, supervisorUserId: user.id, fullName,
      createdById: actorId || null, updatedById: actorId || null,
    });
  }
  return profile;
}

interface LiveClock {
  clockedIn: boolean;
  since: string | null;
  status: string | null;
  lateMinutes: number;
  scheduledEnd: string | null;
  lat: number | null;
  lng: number | null;
}

/** Map supervisorUserId → live clock/attendance from open supervisorShift rows. */
async function liveClockByUser(database: any, tid: string): Promise<Record<string, LiveClock>> {
  const out: Record<string, LiveClock> = {};
  try {
    const open = await database.supervisorShift.findAll({ where: { tenantId: tid, punchOutTime: null } });
    for (const s of open) {
      out[s.supervisorUserId] = {
        clockedIn: true,
        since: s.punchInTime ? new Date(s.punchInTime).toISOString() : null,
        status: s.status || null,
        lateMinutes: s.lateMinutes || 0,
        scheduledEnd: s.scheduledEnd ? new Date(s.scheduledEnd).toISOString() : null,
        lat: s.punchInLat != null ? Number(s.punchInLat) : null,
        lng: s.punchInLng != null ? Number(s.punchInLng) : null,
      };
    }
  } catch { /* supervisorShift optional */ }
  return out;
}

function shape(user: any, profile: any, live?: LiveClock): any {
  const p = profile?.get ? profile.get({ plain: true }) : profile;
  return {
    id: user.id, // the supervisor's USER id is the stable identifier
    profileId: p?.id || null,
    email: user.email || null,
    fullName: user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || '—',
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    phoneNumber: user.phoneNumber || null,
    governmentId: p?.governmentId ?? null,
    gender: p?.gender ?? null,
    bloodType: p?.bloodType ?? null,
    birthDate: p?.birthDate ?? null,
    birthPlace: p?.birthPlace ?? null,
    maritalStatus: p?.maritalStatus ?? null,
    academicInstruction: p?.academicInstruction ?? null,
    address: p?.address ?? null,
    // Live position for the CRM map: prefer the profile (seeded at clock-in +
    // live-ping), fall back to the open shift's clock-in coords.
    latitude: p?.latitude ?? live?.lat ?? null,
    longitude: p?.longitude ?? live?.lng ?? null,
    hiringContractDate: p?.hiringContractDate ?? null,
    guardCredentials: p?.guardCredentials ?? null,
    availability: p?.availability ?? null,
    languages: p?.languages ?? [],
    skills: p?.skills ?? [],
    zone: p?.zone ?? null,
    assignedVehicle: p?.assignedVehicle ?? null,
    // Turno config
    turnoDays: p?.turnoDays ?? null,
    turnoStart: p?.turnoStart ?? null,
    turnoEnd: p?.turnoEnd ?? null,
    mobileStationId: p?.mobileStationId ?? null,
    // Live attendance for the open shift (if any)
    isOnDuty: !!(live?.clockedIn),
    onDutySince: live?.since ?? null,
    dutyStatus: live?.status ?? null,        // on_time | late | no_schedule
    dutyLateMinutes: live?.lateMinutes ?? 0,
    dutyScheduledEnd: live?.scheduledEnd ?? null,
    createdAt: p?.createdAt ?? null,
  };
}

/** GET /tenant/:id/supervisors — list supervisors + profile + live clock status. */
export async function listSupervisors(req: Request): Promise<any> {
  const database = db(req);
  const tid = tenantId(req);
  const actorId = (req as any).currentUser?.id;
  const memberships = await supervisorMemberships(database, tid);
  const live = await liveClockByUser(database, tid);

  const rows: any[] = [];
  for (const tu of memberships) {
    const profile = await ensureProfile(database, tid, tu.user, actorId);
    rows.push(shape(tu.user, profile, live[tu.user.id]));
  }
  rows.sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  return { rows, count: rows.length };
}

/** GET /tenant/:id/supervisors/:userId — one supervisor's full detail. */
export async function getSupervisor(req: Request, userId: string): Promise<any> {
  const database = db(req);
  const tid = tenantId(req);
  const tu = await database.tenantUser.findOne({
    where: { tenantId: tid, userId },
    include: [{ model: database.user, as: 'user' }],
  });
  if (!tu || !tu.user || !rolesOf(tu).includes(SUPERVISOR_ROLE)) throw new Error404((req as any).language);
  const profile = await ensureProfile(database, tid, tu.user, (req as any).currentUser?.id);
  const live = await liveClockByUser(database, tid);
  return shape(tu.user, profile, live[userId]);
}

/**
 * POST /tenant/:id/supervisors — create a supervisor: provision the user with
 * the securitySupervisor role (invite email) + create the profile row.
 * Body: { email, firstName, lastName, ...profileFields }.
 */
export async function createSupervisor(req: Request): Promise<any> {
  const database = db(req);
  const tid = tenantId(req);
  const body = (req.body || {}) as any;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) throw new Error400((req as any).language, undefined, 'email is required');

  const UserRepository = require('../database/repositories/userRepository').default;
  const existing = await UserRepository.findByEmailWithoutAvatar(email, req);

  const UserCreator = require('./user/userCreator').default;
  await new UserCreator(req).execute({
    emails: [email],
    firstName: body.firstName || null,
    lastName: body.lastName || null,
    fullName: body.fullName || undefined,
    roles: [SUPERVISOR_ROLE],
  });

  // Resolve the (now-existing) user and create/patch the profile.
  const user = existing || (await UserRepository.findByEmailWithoutAvatar(email, req));
  if (!user) throw new Error400((req as any).language, undefined, 'Could not resolve created supervisor user');

  const profile = await ensureProfile(database, tid, user, (req as any).currentUser?.id);
  const updates = pickProfile(body);
  if (Object.keys(updates).length) await profile.update({ ...updates, updatedById: (req as any).currentUser?.id });

  return getSupervisor(req, user.id);
}

/** PUT /tenant/:id/supervisors/:userId — update the supervisor's profile fields. */
export async function updateSupervisor(req: Request, userId: string): Promise<any> {
  const database = db(req);
  const tid = tenantId(req);
  const tu = await database.tenantUser.findOne({
    where: { tenantId: tid, userId },
    include: [{ model: database.user, as: 'user' }],
  });
  if (!tu || !tu.user || !rolesOf(tu).includes(SUPERVISOR_ROLE)) throw new Error404((req as any).language);
  const profile = await ensureProfile(database, tid, tu.user, (req as any).currentUser?.id);
  const updates = pickProfile(req.body || {});
  if (Object.keys(updates).length) await profile.update({ ...updates, updatedById: (req as any).currentUser?.id });
  return getSupervisor(req, userId);
}

function pickProfile(body: any): any {
  const out: any = {};
  for (const f of WRITABLE_PROFILE) {
    if (body && body[f] !== undefined) out[f] = body[f];
  }
  return out;
}
