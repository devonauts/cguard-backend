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
import FileRepository from '../database/repositories/fileRepository';

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
    include: [{
      model: database.user, as: 'user',
      attributes: ['id', 'firstName', 'lastName', 'fullName', 'email', 'phoneNumber'],
      include: [{ model: database.file, as: 'avatars' }],
    }],
  });
  return rows.filter((tu: any) => rolesOf(tu).includes(SUPERVISOR_ROLE) && tu.user);
}

/** Resolve the supervisor user's avatar (profile photo) to a download URL, if any. */
async function avatarUrl(user: any): Promise<string | null> {
  try {
    const avatars = Array.isArray(user?.avatars) ? user.avatars : [];
    if (!avatars.length) return null;
    const filled = await FileRepository.fillDownloadUrl(avatars);
    return (filled?.[0] && (filled[0].downloadUrl || filled[0].publicUrl)) || null;
  } catch { return null; }
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

function shape(user: any, profile: any, live?: LiveClock, photoUrl?: string | null): any {
  const p = profile?.get ? profile.get({ plain: true }) : profile;
  return {
    id: user.id, // the supervisor's USER id is the stable identifier
    profileId: p?.id || null,
    photoUrl: photoUrl ?? null,
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
    const photoUrl = await avatarUrl(tu.user);
    rows.push(shape(tu.user, profile, live[tu.user.id], photoUrl));
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
    include: [{ model: database.user, as: 'user', include: [{ model: database.file, as: 'avatars' }] }],
  });
  if (!tu || !tu.user || !rolesOf(tu).includes(SUPERVISOR_ROLE)) throw new Error404((req as any).language);
  const profile = await ensureProfile(database, tid, tu.user, (req as any).currentUser?.id);
  const live = await liveClockByUser(database, tid);
  const photoUrl = await avatarUrl(tu.user);
  const base = shape(tu.user, profile, live[userId], photoUrl);

  // Attendance history (asistencia) + hours for nómina — from the supervisor's shifts.
  let shifts: any[] = [];
  let hoursThisMonth = 0;
  let hoursTotal = 0;
  try {
    const rows = await database.supervisorShift.findAll({
      where: { tenantId: tid, supervisorUserId: userId },
      order: [['punchInTime', 'DESC']],
      limit: 60,
    });
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    shifts = rows.map((r: any) => {
      const s = r.get ? r.get({ plain: true }) : r;
      const hw = s.hoursWorked != null ? Number(s.hoursWorked) : null;
      if (hw) { hoursTotal += hw; if (new Date(s.punchInTime) >= monthStart) hoursThisMonth += hw; }
      return {
        id: s.id,
        punchInTime: s.punchInTime,
        punchOutTime: s.punchOutTime,
        hoursWorked: hw,
        status: s.status,
        lateMinutes: s.lateMinutes,
        breaks: Array.isArray(s.breaks) ? s.breaks.length : 0,
      };
    });
  } catch { /* attendance history optional */ }

  return {
    ...base,
    shifts,
    hoursThisMonth: Math.round(hoursThisMonth * 100) / 100,
    hoursTotal: Math.round(hoursTotal * 100) / 100,
  };
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

/** Resolve the supervisor tenantUser (+ user) for an action, or 404. */
async function supervisorTenantUser(req: Request, userId: string): Promise<any> {
  const database = db(req);
  const tid = tenantId(req);
  const tu = await database.tenantUser.findOne({
    where: { tenantId: tid, userId },
    include: [{ model: database.user, as: 'user' }],
  });
  if (!tu || !tu.user || !rolesOf(tu).includes(SUPERVISOR_ROLE)) throw new Error404((req as any).language);
  return tu;
}

/**
 * POST /tenant/:id/supervisors/:userId/resend-invite — (re)send the "acceso a la
 * app" invitation so the supervisor can create their account. Mirrors the guard
 * resend flow but points at the supervisor app registration screen
 * (`/supervisor/registration?...&inviteType=supervisor`, same as UserCreator).
 */
export async function resendSupervisorInvite(req: Request, userId: string): Promise<any> {
  const tu = await supervisorTenantUser(req, userId);
  const user = tu.user;
  const email = user.email && !String(user.email).endsWith('@phone.local') ? String(user.email).trim() : null;
  if (!email) {
    throw new Error400((req as any).language, undefined, 'El supervisor no tiene un correo registrado. Edita su perfil y agrega un correo para poder enviarle el acceso a la app.');
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { invitationTokenExpiry } = require('./auth/invitationToken');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const TenantRepository = require('../database/repositories/tenantRepository').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tenantSubdomain } = require('./tenantSubdomain');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EmailSender = require('./emailSender').default;

  // Refresh the invitation token + expiry so the emailed link is always valid.
  tu.invitationToken = tu.invitationToken || crypto.randomBytes(20).toString('hex');
  tu.invitationTokenExpiresAt = invitationTokenExpiry();
  await tu.save();

  const tenant = await TenantRepository.findById(tenantId(req), req);
  const link = `${tenantSubdomain.frontendUrl(tenant)}/supervisor/registration?token=${encodeURIComponent(tu.invitationToken)}&inviteType=supervisor`;

  let emailed = false;
  try {
    await new EmailSender(EmailSender.TEMPLATES.INVITATION, {
      tenant: tenant || null,
      link,
      invitationLink: link,
      inviteLink: link,
      registrationLink: link,
      invitation: true,
      // Supervisors get the waiting-screen (client-style) invitation, matching
      // UserCreator — their home is the supervisor app, not this CRM.
      type: 'client-invitation',
      firstName: user.firstName || undefined,
      lastName: user.lastName || undefined,
      email,
    }).sendTo(email);
    emailed = true;
  } catch (e: any) {
    console.warn('[resendSupervisorInvite] email failed:', e?.message || e);
  }

  return { resent: true, emailed, email, link };
}

/**
 * POST /tenant/:id/supervisors/:userId/send-password-reset — admin-triggered
 * password reset for a supervisor. Emails the reset link (web page works on any
 * device) and best-effort pushes to their registered devices.
 */
export async function sendSupervisorPasswordReset(req: Request, userId: string): Promise<any> {
  const tu = await supervisorTenantUser(req, userId);
  const user = tu.user;
  const email = user.email && !String(user.email).endsWith('@phone.local') ? String(user.email).trim() : null;
  if (!email) {
    throw new Error400((req as any).language, undefined, 'El supervisor no tiene un correo registrado. Edita su perfil y agrega un correo para poder restablecer su contraseña.');
  }
  const lower = email.toLowerCase();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const UserRepository = require('../database/repositories/userRepository').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const TenantRepository = require('../database/repositories/tenantRepository').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tenantSubdomain } = require('./tenantSubdomain');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EmailSender = require('./emailSender').default;

  const token = await UserRepository.generatePasswordResetToken(lower, req);
  const tenant = await TenantRepository.findById(tenantId(req), req);
  const link = `${tenantSubdomain.frontendUrl(tenant)}/reset-password?token=${token}`;

  let emailed = false;
  try {
    if (EmailSender.isConfigured) {
      await new EmailSender(EmailSender.TEMPLATES.PASSWORD_RESET, { link, passwordReset: true }).sendTo(lower);
      emailed = true;
    }
  } catch (e: any) {
    console.warn('[supervisor password reset] email failed:', e?.message || e);
  }

  let pushed = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pushToUser } = require('./pushService');
    const r = await pushToUser(db(req), tenantId(req), userId, {
      title: 'Restablece tu contraseña',
      body: 'Un administrador solicitó restablecer tu contraseña. Revisa tu correo o toca para continuar.',
      data: { type: 'password_reset', link },
    });
    pushed = (r && r.sent) || 0;
  } catch (e: any) {
    console.warn('[supervisor password reset] push failed:', e?.message || e);
  }

  return { success: true, email: lower, emailed, pushed, link };
}
