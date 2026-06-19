/**
 * ============================================================================
 *  DEMO TENANT SEED  —  "Vigilancia Andina Demo"
 * ============================================================================
 *
 * Idempotently creates the ENTIRE self-contained demo tenant used by the
 * superadmin "Demo Control" orchestrator during live sales calls.
 *
 * It is SAFE TO RE-RUN: every entity is found-or-created by a stable key
 * (fixed demo emails, the fixed tenant slug DEMO_URL_SLUG, deterministic
 * names scoped to the demo tenant). Re-running never duplicates rows and
 * never touches any other tenant.
 *
 * WHAT IT CREATES
 *   - Tenant            "Vigilancia Andina Demo" (Ecuador, America/Guayaquil)
 *   - Admin user        Carlos Méndez   admin@demo.cguardpro.com (roles: admin)
 *   - Client portal user María Torres   cliente@demo.cguardpro.com (roles: customer)
 *   - ClientAccount     "Comercial Pacífico S.A." (linked to María)
 *   - Site/businessInfo "Torre Empresarial Pacífico" (geofence near Guayaquil)
 *   - 3 stations        (2 post sites + a perimeter post) with geofence radius
 *   - 2 turno guards    Juan Ramírez (día) + Pedro Vásquez (noche), full profiles
 *   - guardAssignments  día+noche so the scheduler engine can regenerate
 *   - Today's shifts    Día (07-19) + Noche (19-07) at the main station
 *   - Patrol checkpoints (3) on the día station for the ronda step
 *   - IncidentType      "Persona sospechosa" for the incident step
 *   - Settings          geofence validation OFF + welcome emails OFF (demo-safe)
 *   - Real public image URLs on every avatar/logo/photo (file rows w/ publicUrl)
 *
 * At the END it prints a single JSON block (between BEGIN/END markers) with
 * every id + credential so the orchestrator + credentials file can be built
 * from it programmatically.
 *
 * RUN
 *   cd backend
 *   npx ts-node scripts/seedDemoTenant.ts
 *   # optional: force-reset all demo passwords to the shared password
 *   DEMO_RESET=1 npx ts-node scripts/seedDemoTenant.ts
 *
 * ENV (all optional)
 *   DEMO_PASSWORD   shared password for all demo accounts (default Demo2026*)
 *   DEMO_RESET=1    reset passwords + re-apply demo-safe settings on re-run
 *
 * NOTE: This script does NOT run the 7 operations. It only builds the clean
 * seeded baseline. The orchestrator (Component B) fires the live steps and the
 * RESET action restores this baseline.
 * ============================================================================
 */
require('dotenv').config();

import bcrypt from 'bcryptjs';
import models from '../src/database/models';

// ── Stable identity constants (DO NOT CHANGE — orchestrator hard-gates on these)
const DEMO_TENANT_NAME = 'Vigilancia Andina Demo';
const DEMO_URL_SLUG = 'vigilancia-andina-demo'; // unique tenant.url → re-run anchor
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo2026*';
const DEMO_RESET = process.env.DEMO_RESET === '1';
const BCRYPT_ROUNDS = 12; // identity-map mandates 12 (seedGuard.ts uses 8 — wrong)

const EMAILS = {
  admin: 'admin@demo.cguardpro.com',
  client: 'cliente@demo.cguardpro.com',
  supervisor: 'supervisor@demo.cguardpro.com',
  guardDia: 'guardia.dia@demo.cguardpro.com',
  guardNoche: 'guardia.noche@demo.cguardpro.com',
};

// Guayaquil geofence center (Torre Empresarial Pacífico, generic coordinates).
const GEO = { lat: -2.170998, lng: -79.922359 };

// Real public image URLs (no auth, hot-linkable CDNs).
const IMG = {
  adminAvatar: 'https://randomuser.me/api/portraits/men/41.jpg',
  clientAvatar: 'https://randomuser.me/api/portraits/women/68.jpg',
  supervisorAvatar: 'https://randomuser.me/api/portraits/men/54.jpg',
  guardDiaAvatar: 'https://randomuser.me/api/portraits/men/32.jpg',
  guardNocheAvatar: 'https://randomuser.me/api/portraits/men/76.jpg',
  tenantLogo: 'https://ui-avatars.com/api/?name=Vigilancia+Andina&background=0D47A1&color=fff&size=256',
  clientLogo: 'https://ui-avatars.com/api/?name=Comercial+Pacifico&background=00695C&color=fff&size=256',
  sitePhoto: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&q=80',
};

type Db = any;

/** Hash the shared demo password (bcrypt, 12 rounds). */
function hashPwd(): string {
  return bcrypt.hashSync(DEMO_PASSWORD, BCRYPT_ROUNDS);
}

/**
 * Attach (or refresh) a single external-URL image to a model record via the
 * polymorphic `files` table. Idempotent: removes any prior file for the
 * relation, then inserts one row with publicUrl set (no binary upload).
 */
async function attachImage(
  db: Db,
  belongsTo: string,        // model table name, e.g. 'securityGuards'
  belongsToColumn: string,  // relation alias, e.g. 'profileImage'
  belongsToId: string,      // record id
  tenantId: string,
  publicUrl: string,
  name: string,
): Promise<void> {
  await db.file.destroy({
    where: { belongsTo, belongsToColumn, belongsToId },
    force: true, // hard-delete so re-runs don't leave soft-deleted stale rows
  });
  await db.file.create({
    belongsTo,
    belongsToColumn,
    belongsToId,
    name,
    publicUrl,
    sizeInBytes: 0,
    mimeType: 'image/jpeg',
    tenantId,
  });
}

/**
 * Find-or-create a user by email. On re-run: optionally resets the password
 * and always refreshes avatarUrl + name. Returns the user record.
 */
async function upsertUser(
  db: Db,
  opts: { email: string; fullName: string; firstName: string; lastName: string; phoneNumber: string; avatarUrl: string },
): Promise<any> {
  const email = opts.email.toLowerCase();
  let user = await db.user.findOne({ where: { email } });
  const base: any = {
    fullName: opts.fullName,
    firstName: opts.firstName,
    lastName: opts.lastName,
    phoneNumber: opts.phoneNumber,
    emailVerified: true,
  };
  // avatarUrl is a plain TEXT column (migration 20260429) — set directly if present.
  if (await columnExists(db, 'users', 'avatarUrl')) base.avatarUrl = opts.avatarUrl;

  if (user) {
    const patch: any = { ...base };
    if (DEMO_RESET) patch.password = hashPwd();
    await user.update(patch);
  } else {
    const data: any = { email, password: hashPwd(), ...base };
    user = await db.user.create(data);
  }
  return user;
}

/** Cache for describeTable lookups. */
const _colCache: Record<string, Set<string>> = {};
async function columnExists(db: Db, table: string, col: string): Promise<boolean> {
  if (!_colCache[table]) {
    try {
      const desc = await db.sequelize.getQueryInterface().describeTable(table);
      _colCache[table] = new Set(Object.keys(desc));
    } catch {
      _colCache[table] = new Set();
    }
  }
  return _colCache[table].has(col);
}

/** Ensure a tenantUser membership exists with (at least) the given roles. */
async function upsertMembership(db: Db, tenantId: string, userId: string, roles: string[]): Promise<any> {
  let m = await db.tenantUser.findOne({ where: { userId, tenantId } });
  if (m) {
    const current: string[] = Array.isArray(m.roles) ? m.roles : [];
    const merged = Array.from(new Set([...current, ...roles]));
    if (merged.length !== current.length || m.status !== 'active') {
      await m.update({ roles: merged, status: 'active' });
    }
  } else {
    m = await db.tenantUser.create({ userId, tenantId, roles, status: 'active' });
  }
  return m;
}

/**
 * Build today's UTC start/end for a 12h shift given a local wall-clock hour in
 * the tenant timezone. Ecuador is a fixed UTC-5 (no DST), so we offset directly.
 *  - Día  : 07:00 → 19:00 local  == 12:00Z → 00:00Z(+1)
 *  - Noche: 19:00 → 07:00(+1) local == 00:00Z(+1) → 12:00Z(+1)
 */
function todayShiftUtc(localStartHour: number, durationH = 12): { start: Date; end: Date } {
  const ECUADOR_UTC_OFFSET = 5; // hours behind UTC
  const now = new Date();
  // Anchor to "today" in Ecuador local date.
  const localNow = new Date(now.getTime() - ECUADOR_UTC_OFFSET * 3600_000);
  const y = localNow.getUTCFullYear();
  const mo = localNow.getUTCMonth();
  const d = localNow.getUTCDate();
  // local hour H == UTC (H + 5)
  const startUtcHour = localStartHour + ECUADOR_UTC_OFFSET;
  const start = new Date(Date.UTC(y, mo, d, startUtcHour, 0, 0));
  const end = new Date(start.getTime() + durationH * 3600_000);
  return { start, end };
}

async function seed() {
  const db = models();

  // ── Bail-out guards never run on real prod data unexpectedly: we ONLY ever
  //    write to records keyed by the demo slug / demo emails. Nothing here
  //    queries or mutates other tenants.

  // 1) TENANT (anchor on the unique url slug for idempotency).
  let tenant = await db.tenant.findOne({ where: { url: DEMO_URL_SLUG } });
  const tenantData: any = {
    name: DEMO_TENANT_NAME,
    url: DEMO_URL_SLUG,
    email: EMAILS.admin,
    businessTitle: 'Vigilancia Andina Cía. Ltda.',
    country: 'Ecuador',
    city: 'Guayaquil',
    address: 'Av. Francisco de Orellana y Justino Cornejo',
    postalCode: '090112',
    phone: '+593 4 260 0000',
    latitude: GEO.lat,
    longitude: GEO.lng,
    timezone: 'America/Guayaquil',
    plan: 'enterprise',
    planStatus: 'active',
    billingStatus: 'active',
    onboardingCompleted: true,
    licenseNumber: 'PN-ECU-DEMO-0001',
    website: 'https://demo.cguardpro.com',
  };
  if (tenant) {
    await tenant.update(tenantData);
  } else {
    tenant = await db.tenant.create(tenantData);
  }
  const tenantId = tenant.id;
  await attachImage(db, db.tenant.getTableName(), 'logo', tenantId, tenantId, IMG.tenantLogo, 'logo.png');
  // tenant.logoId points at the file row when present.
  const logoFile = await db.file.findOne({ where: { belongsTo: db.tenant.getTableName(), belongsToColumn: 'logo', belongsToId: tenantId } });
  if (logoFile && tenant.logoId !== logoFile.id) await tenant.update({ logoId: logoFile.id });

  // 2) SETTINGS — demo-safe: geofence validation OFF, welcome emails OFF.
  const [settings] = await db.settings.findOrCreate({
    where: { tenantId },
    defaults: { id: tenantId, tenantId, theme: 'default' },
  });
  if (!settings.theme) await settings.update({ theme: 'default' });
  if (DEMO_RESET || !settings.nominaSettings || !settings.nominaSettings.geofence) {
    const nomina = { ...(settings.nominaSettings || {}) };
    nomina.geofence = {
      ...(nomina.geofence || {}),
      defaultRadiusM: 2000,
      requireValidation: false,        // never block a demo punch on location
      allowOutsideWithApproval: true,
    };
    await settings.update({ nominaSettings: nomina, clientWelcomeEmailEnabled: false });
  }

  // 3) ADMIN USER (Carlos Méndez).
  const admin = await upsertUser(db, {
    email: EMAILS.admin, fullName: 'Carlos Méndez', firstName: 'Carlos', lastName: 'Méndez',
    phoneNumber: '+593 99 100 0001', avatarUrl: IMG.adminAvatar,
  });
  await upsertMembership(db, tenantId, admin.id, ['admin']);

  // 4) CLIENT PORTAL USER (María Torres) + ClientAccount (Comercial Pacífico S.A.).
  const clientUser = await upsertUser(db, {
    email: EMAILS.client, fullName: 'María Torres', firstName: 'María', lastName: 'Torres',
    phoneNumber: '+593 99 100 0002', avatarUrl: IMG.clientAvatar,
  });
  await upsertMembership(db, tenantId, clientUser.id, ['customer']);

  let client = await db.clientAccount.findOne({ where: { tenantId, userId: clientUser.id } });
  const clientData: any = {
    tenantId,
    userId: clientUser.id,
    name: 'María',
    lastName: 'Torres',
    email: EMAILS.client,
    phoneNumber: '+593 99 100 0002',
    commercialName: 'Comercial Pacífico S.A.',
    personType: 'PJ',
    documentNumber: '0992233445001',
    address: 'Av. 9 de Octubre 100 y Malecón',
    city: 'Guayaquil',
    country: 'Ecuador',
    zipCode: '090313',
    latitude: GEO.lat,
    longitude: GEO.lng,
    onboardingStatus: 'active',
    active: true,
  };
  if (client) {
    await client.update(clientData);
  } else {
    client = await db.clientAccount.create(clientData);
  }
  await attachImage(db, db.clientAccount.getTableName(), 'logoUrl', client.id, tenantId, IMG.clientLogo, 'client-logo.png');

  // 4b) SUPERVISOR (Andrés Pólit) — drives the vehicle patrol on the live map.
  const supervisor = await upsertUser(db, {
    email: EMAILS.supervisor, fullName: 'Andrés Pólit', firstName: 'Andrés', lastName: 'Pólit',
    phoneNumber: '+593 99 100 0005', avatarUrl: IMG.supervisorAvatar,
  });
  await upsertMembership(db, tenantId, supervisor.id, ['securitySupervisor']);

  // 5) SITE / businessInfo (Torre Empresarial Pacífico) linked to the client.
  let site = await db.businessInfo.findOne({ where: { tenantId, companyName: 'Torre Empresarial Pacífico' } });
  const siteData: any = {
    tenantId,
    companyName: 'Torre Empresarial Pacífico',
    description: 'Edificio corporativo de 14 pisos con parqueadero subterráneo y perímetro vallado.',
    clientAccountId: client.id,
    contactPhone: '+593 4 260 0001',
    contactEmail: EMAILS.client,
    latitud: GEO.lat,
    longitud: GEO.lng,
    address: 'Av. Francisco de Orellana y Justino Cornejo, Guayaquil',
    city: 'Guayaquil',
    country: 'Ecuador',
    postalCode: '090112',
    serviceType: 'manned',
    active: true,
  };
  if (site) {
    await site.update(siteData);
  } else {
    site = await db.businessInfo.create(siteData);
  }
  await attachImage(db, db.businessInfo.getTableName(), 'logo', site.id, tenantId, IMG.sitePhoto, 'site-photo.jpg');

  // 6) STATIONS (post sites within the site). The first is the main/día post.
  const stationDefs = [
    { stationName: 'Garita Principal', nickname: 'P-01', scheduleType: '24h', dLat: 0, dLng: 0 },
    { stationName: 'Lobby Recepción', nickname: 'P-02', scheduleType: '12h-day', dLat: 0.0004, dLng: 0.0003 },
    { stationName: 'Perímetro Posterior', nickname: 'P-03', scheduleType: '12h-night', dLat: -0.0005, dLng: 0.0006 },
  ];
  const stations: any[] = [];
  for (const def of stationDefs) {
    let st = await db.station.findOne({ where: { tenantId, postSiteId: site.id, stationName: def.stationName } });
    const stData: any = {
      tenantId,
      postSiteId: site.id,
      stationName: def.stationName,
      nickname: def.nickname,
      latitud: GEO.lat + def.dLat,
      longitud: GEO.lng + def.dLng,
      geofenceRadius: 2000, // wide so demo punches from anywhere succeed
      scheduleType: def.scheduleType,
      stationSchedule: '12 horas',
      createdById: admin.id,
    };
    if (st) {
      await st.update(stData);
    } else {
      st = await db.station.create(stData);
    }
    stations.push(st);
  }
  const mainStation = stations[0]; // Garita Principal — día+noche relevo happen here.

  // 7) GUARDS (Juan Ramírez día, Pedro Vásquez noche) — user + membership + profile.
  async function upsertGuard(opts: {
    email: string; fullName: string; firstName: string; lastName: string;
    phoneNumber: string; avatarUrl: string; cedula: string; birthDate: string; hireDate: string;
  }): Promise<any> {
    const user = await upsertUser(db, {
      email: opts.email, fullName: opts.fullName, firstName: opts.firstName, lastName: opts.lastName,
      phoneNumber: opts.phoneNumber, avatarUrl: opts.avatarUrl,
    });
    await upsertMembership(db, tenantId, user.id, ['securityGuard']);

    let guard = await db.securityGuard.findOne({ where: { tenantId, guardId: user.id } });
    const gData: any = {
      tenantId,
      guardId: user.id,
      governmentId: opts.cedula,
      fullName: opts.fullName, // denormalized cache; written here only at creation
      gender: 'Masculino',
      bloodType: 'O+',
      birthDate: opts.birthDate,
      hiringContractDate: opts.hireDate,
      maritalStatus: 'Casado',
      academicInstruction: 'Secundaria',
      address: 'Guayaquil, Guayas, Ecuador',
      latitude: GEO.lat,
      longitude: GEO.lng,
      guardType: 'titular',
      isOnDuty: false,
    };
    if (guard) {
      await guard.update(gData);
    } else {
      guard = await db.securityGuard.create(gData);
    }
    await attachImage(db, db.securityGuard.getTableName(), 'profileImage', guard.id, tenantId, opts.avatarUrl, 'profile.jpg');
    return { user, guard };
  }

  const dia = await upsertGuard({
    email: EMAILS.guardDia, fullName: 'Juan Ramírez', firstName: 'Juan', lastName: 'Ramírez',
    phoneNumber: '+593 99 100 0003', avatarUrl: IMG.guardDiaAvatar,
    cedula: '0923456781', birthDate: '1990-03-15', hireDate: '2023-01-10',
  });
  const noche = await upsertGuard({
    email: EMAILS.guardNoche, fullName: 'Pedro Vásquez', firstName: 'Pedro', lastName: 'Vásquez',
    phoneNumber: '+593 99 100 0004', avatarUrl: IMG.guardNocheAvatar,
    cedula: '0934567892', birthDate: '1988-07-22', hireDate: '2022-09-05',
  });

  // 8) GUARD ASSIGNMENTS (so the scheduler engine can regenerate if needed).
  //    kind='adhoc' with explicit HH:mm windows on the main station.
  async function upsertAssignment(guardUserId: string, startHHmm: string, endHHmm: string): Promise<any> {
    let a = await db.guardAssignment.findOne({
      where: { tenantId, guardId: guardUserId, stationId: mainStation.id, kind: 'adhoc' },
    });
    const today = new Date().toISOString().slice(0, 10);
    const aData: any = {
      tenantId,
      guardId: guardUserId,
      stationId: mainStation.id,
      kind: 'adhoc',
      startTime: startHHmm,
      endTime: endHHmm,
      startDate: today,
      endDate: null,
      status: 'active',
    };
    if (a) {
      await a.update(aData);
    } else {
      a = await db.guardAssignment.create(aData);
    }
    return a;
  }
  await upsertAssignment(dia.user.id, '07:00', '19:00');
  await upsertAssignment(noche.user.id, '19:00', '07:00');

  // 8b) Link both guards to the main station via the `assignedGuards` junction.
  //     The worker-app clock-in screen derives its stations from this junction
  //     (station.assignedGuards) — without it the guard has no post to clock into
  //     and the clock-in button never appears (no error shown). Idempotent.
  await mainStation.addAssignedGuards([dia.user.id, noche.user.id]);

  // 9) TODAY'S SHIFTS (Día 07-19, Noche 19-07) at the main station.
  //    Created directly so the demo baseline is deterministic. The unique
  //    index (tenantId,guardId,stationId,startTime,endTime) makes this idempotent.
  async function upsertShift(guardUserId: string, localStartHour: number): Promise<any> {
    const { start, end } = todayShiftUtc(localStartHour, 12);
    let sh = await db.shift.findOne({
      where: { tenantId, guardId: guardUserId, stationId: mainStation.id, startTime: start, endTime: end },
    });
    const shData: any = {
      tenantId,
      guardId: guardUserId,
      stationId: mainStation.id,
      postSiteId: site.id,
      startTime: start,
      endTime: end,
      tzFixed: true,
      createdById: admin.id,
    };
    if (sh) {
      await sh.update(shData);
    } else {
      sh = await db.shift.create(shData);
    }
    return sh;
  }
  const shiftDia = await upsertShift(dia.user.id, 7);
  const shiftNoche = await upsertShift(noche.user.id, 19);

  // 10) PATROL CHECKPOINTS on the main station (for the ronda step; 1 will be "missed").
  const checkpointDefs = [
    { name: 'CP-1 Acceso Principal', dLat: 0.0001, dLng: 0.0001 },
    { name: 'CP-2 Parqueadero', dLat: 0.0003, dLng: -0.0002 },
    { name: 'CP-3 Azotea', dLat: -0.0002, dLng: 0.0004 },
  ];
  const checkpoints: any[] = [];
  for (const def of checkpointDefs) {
    let cp = await db.patrolCheckpoint.findOne({ where: { tenantId, stationId: mainStation.id, name: def.name } });
    const cpData: any = {
      tenantId,
      stationId: mainStation.id,
      name: def.name,
      latitud: GEO.lat + def.dLat,
      longitud: GEO.lng + def.dLng,
      createdById: admin.id,
    };
    if (cp) {
      await cp.update(cpData);
    } else {
      cp = await db.patrolCheckpoint.create(cpData);
    }
    checkpoints.push(cp);
  }

  // 10b) PATROL (ronda) parent — assigned to the día guard at the main station,
  //      with the 3 checkpoints linked via the M2M association. The orchestrator's
  //      patrol step (PatrolLogService.create) loads patrol.checkpoints to validate
  //      proximity, so without this row the ronda step has nothing to scan.
  let patrol = await db.patrol.findOne({ where: { tenantId, stationId: mainStation.id, assignedGuardId: dia.user.id } });
  const patrolData: any = {
    tenantId,
    stationId: mainStation.id,
    assignedGuardId: dia.user.id,
    scheduledTime: new Date(),
    completed: false,
    status: 'Incomplete',
  };
  if (patrol) {
    await patrol.update(patrolData);
  } else {
    patrol = await db.patrol.create(patrolData);
  }
  // Link checkpoints (idempotent — setCheckpoints replaces the through rows).
  await patrol.setCheckpoints(checkpoints.map((c: any) => c.id));

  // 11) INCIDENT TYPE (for the incident step).
  let incidentType = await db.incidentType.findOne({ where: { tenantId, name: 'Persona sospechosa' } });
  if (!incidentType) {
    incidentType = await db.incidentType.create({
      tenantId, name: 'Persona sospechosa', active: true, createdById: admin.id,
    });
  }

  // ── CREDENTIALS + IDS JSON (machine-readable, between markers).
  const out = {
    sharedPassword: DEMO_PASSWORD,
    tenant: {
      id: tenantId,
      name: DEMO_TENANT_NAME,
      url: DEMO_URL_SLUG,
      timezone: 'America/Guayaquil',
      country: 'Ecuador',
    },
    accounts: {
      admin: { userId: admin.id, email: EMAILS.admin, password: DEMO_PASSWORD, fullName: 'Carlos Méndez', roles: ['admin'] },
      client: { userId: clientUser.id, email: EMAILS.client, password: DEMO_PASSWORD, fullName: 'María Torres', roles: ['customer'], clientAccountId: client.id },
      supervisor: { userId: supervisor.id, email: EMAILS.supervisor, password: DEMO_PASSWORD, fullName: 'Andrés Pólit', roles: ['securitySupervisor'] },
      guardDia: { userId: dia.user.id, securityGuardId: dia.guard.id, email: EMAILS.guardDia, password: DEMO_PASSWORD, fullName: 'Juan Ramírez', turno: 'dia' },
      guardNoche: { userId: noche.user.id, securityGuardId: noche.guard.id, email: EMAILS.guardNoche, password: DEMO_PASSWORD, fullName: 'Pedro Vásquez', turno: 'noche' },
    },
    site: { id: site.id, companyName: 'Torre Empresarial Pacífico', geofence: { lat: GEO.lat, lng: GEO.lng } },
    stations: stations.map((s: any) => ({ id: s.id, stationName: s.stationName, nickname: s.nickname, scheduleType: s.scheduleType })),
    mainStationId: mainStation.id,
    shifts: {
      dia: { id: shiftDia.id, guardUserId: dia.user.id, startTime: shiftDia.startTime, endTime: shiftDia.endTime },
      noche: { id: shiftNoche.id, guardUserId: noche.user.id, startTime: shiftNoche.startTime, endTime: shiftNoche.endTime },
    },
    patrolId: patrol.id,
    patrolCheckpoints: checkpoints.map((c: any) => ({ id: c.id, name: c.name })),
    incidentTypeId: incidentType.id,
  };

  console.log('\n✅ Demo tenant seeded/refreshed.');
  console.log('\n===DEMO_SEED_JSON_BEGIN===');
  console.log(JSON.stringify(out, null, 2));
  console.log('===DEMO_SEED_JSON_END===\n');

  process.exit(0);
}

seed().catch((err: any) => {
  if (err && err.errors) {
    console.error('Validation error:', err.errors.map((e: any) => `${e.path}: ${e.message}`).join('; '));
  } else {
    console.error(err);
  }
  process.exit(1);
});
