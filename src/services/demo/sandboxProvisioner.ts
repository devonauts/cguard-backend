/**
 * Sandbox provisioner — spins up a fresh, prospect-branded, fully-populated
 * TRIAL tenant on demand (superadmin → Sandboxes). Sales hands the login to a
 * prospect as a personalized, data-rich demo/leave-behind.
 *
 * SELF-CONTAINED BY DESIGN: this reproduces the demo baseline + a slice of
 * operational history using the SAME proven patterns as scripts/seedDemoTenant.ts
 * and services/demo/demoOrchestratorService.ts, but it NEVER touches the live-demo
 * tenant or its seed. Every sandbox is a brand-new tenant (unique slug + emails),
 * so it can never collide with the hard-gated demo tenant.
 *
 * Produces: branded org + client portal account + site + 3 stations + 2 guards +
 * supervisor + today's schedule + patrol w/ checkpoints, PLUS operational history
 * (a visitor log, 2 incidents, a completed patrol round). On the Trial tier so it
 * behaves like a real trial (paywall/entitlements apply).
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDefaultPlanKey } from '../planCatalogService';
import { sendMail } from '../mailService';

type Db = any;

/** From-address for sandbox credential emails. Override with SANDBOX_EMAIL_FROM. */
const SANDBOX_EMAIL_FROM =
  process.env.SANDBOX_EMAIL_FROM || 'CGuardPro Demo <demo@cguardpro.com>';

const GEO = { lat: -2.170998, lng: -79.922359 }; // Guayaquil
const BCRYPT_ROUNDS = 12;

const AVATARS = {
  admin: 'https://randomuser.me/api/portraits/men/41.jpg',
  client: 'https://randomuser.me/api/portraits/women/68.jpg',
  supervisor: 'https://randomuser.me/api/portraits/men/54.jpg',
  guardDay: 'https://randomuser.me/api/portraits/men/32.jpg',
  guardNight: 'https://randomuser.me/api/portraits/men/76.jpg',
  site: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&q=80',
};

function slugify(s: string): string {
  return String(s || 'prospecto')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'prospecto';
}

function brandLogo(name: string): string {
  const label = encodeURIComponent(String(name || 'Demo').slice(0, 24));
  return `https://ui-avatars.com/api/?name=${label}&background=0D47A1&color=fff&size=256`;
}

async function attachImage(
  db: Db, belongsTo: string, belongsToColumn: string, belongsToId: string,
  tenantId: string, publicUrl: string, name: string,
): Promise<void> {
  await db.file.destroy({ where: { belongsTo, belongsToColumn, belongsToId }, force: true });
  await db.file.create({
    belongsTo, belongsToColumn, belongsToId, name, publicUrl,
    sizeInBytes: 0, mimeType: 'image/jpeg', tenantId,
  });
}

const _colCache: Record<string, Set<string>> = {};
async function columnExists(db: Db, table: string, col: string): Promise<boolean> {
  if (!_colCache[table]) {
    try {
      const desc = await db.sequelize.getQueryInterface().describeTable(table);
      _colCache[table] = new Set(Object.keys(desc));
    } catch { _colCache[table] = new Set(); }
  }
  return _colCache[table].has(col);
}

async function createUser(
  db: Db, pwdHash: string,
  o: { email: string; fullName: string; firstName: string; lastName: string; phoneNumber: string; avatarUrl: string },
): Promise<any> {
  const email = o.email.toLowerCase();
  const base: any = {
    email, password: pwdHash,
    fullName: o.fullName, firstName: o.firstName, lastName: o.lastName,
    phoneNumber: o.phoneNumber, emailVerified: true,
  };
  if (await columnExists(db, 'users', 'avatarUrl')) base.avatarUrl = o.avatarUrl;
  return db.user.create(base);
}

async function addMembership(db: Db, tenantId: string, userId: string, roles: string[]): Promise<any> {
  return db.tenantUser.create({ userId, tenantId, roles, status: 'active' });
}

/** Today's UTC window for a 12h shift given a local start hour (Ecuador = UTC-5). */
function todayShiftUtc(localStartHour: number, durationH = 12): { start: Date; end: Date } {
  const OFFSET = 5;
  const now = new Date();
  const localNow = new Date(now.getTime() - OFFSET * 3600_000);
  const start = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), localStartHour + OFFSET, 0, 0));
  return { start, end: new Date(start.getTime() + durationH * 3600_000) };
}

export interface SandboxAccount {
  role: string;
  email: string;
  password: string;
  fullName: string;
}

export interface SandboxResult {
  tenantId: string;
  tenantName: string;
  slug: string;
  loginUrl: string;
  sharedPassword: string;
  accounts: SandboxAccount[];
  /** Set when credentials were emailed. */
  emailedTo?: string | null;
  emailSent?: boolean;
  emailError?: string | null;
}

export interface ProvisionOpts {
  brandName: string;
  ownerEmail?: string | null;
  ownerFullName?: string | null;
  /** If set, email the credentials to this address (from demo@cguardpro.com). */
  sendCredentialsTo?: string | null;
}

const esc = (s: string) =>
  String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Branded HTML for the sandbox-credentials email. */
function credentialsEmailHtml(r: SandboxResult): string {
  const rows = r.accounts
    .map(
      (a) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#111">${esc(a.role)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;color:#333">${esc(a.email)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;color:#333">${esc(a.password)}</td>
        </tr>`,
    )
    .join('');
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">
    <h2 style="color:#0D47A1;margin-bottom:4px">Tu demo de CGuardPro está lista</h2>
    <p style="margin-top:0;color:#555">Preparamos un entorno de prueba para <b>${esc(r.tenantName)}</b>, ya cargado con
    guardias, sitios, horario e historial de operación para que lo explores como si fuera tu operación real.</p>
    <p style="margin:20px 0">
      <a href="${esc(r.loginUrl)}" style="background:#0D47A1;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
        Ingresar a la plataforma
      </a>
    </p>
    <p style="color:#555;margin-bottom:6px">Accesos (todas las cuentas usan la misma contraseña):</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead>
        <tr style="background:#f5f7fa">
          <th style="text-align:left;padding:8px 12px;color:#555">Rol</th>
          <th style="text-align:left;padding:8px 12px;color:#555">Correo</th>
          <th style="text-align:left;padding:8px 12px;color:#555">Contraseña</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:12px;margin-top:24px">
      Entorno de prueba de CGuardPro. Si no solicitaste esta demo, ignora este correo.
    </p>
  </div>`;
}

/**
 * Email the sandbox credentials from demo@cguardpro.com. Best-effort: never
 * throws — returns whether it sent (so provisioning succeeds even if mail fails).
 */
async function emailCredentials(r: SandboxResult, to: string): Promise<{ sent: boolean; error?: string }> {
  try {
    await sendMail({
      to,
      from: SANDBOX_EMAIL_FROM,
      subject: `Tu demo de CGuardPro — ${r.tenantName}`,
      html: credentialsEmailHtml(r),
    });
    return { sent: true };
  } catch (e: any) {
    return { sent: false, error: e?.message || 'mail send failed' };
  }
}

/**
 * Provision a fully-populated, branded trial sandbox. Returns the login
 * credentials for every seeded role.
 */
export async function provisionSandbox(db: Db, opts: ProvisionOpts): Promise<SandboxResult> {
  const brand = String(opts.brandName || '').trim();
  if (!brand) throw new Error('brandName is required');

  const slugBase = slugify(brand);
  const suffix = crypto.randomBytes(3).toString('hex');
  const slug = `${slugBase}-${suffix}`.slice(0, 45);
  const domain = `${slug}.sandbox.cguardpro.com`;
  const sharedPassword = `Demo-${crypto.randomBytes(3).toString('hex')}A1`;
  const pwdHash = bcrypt.hashSync(sharedPassword, BCRYPT_ROUNDS);

  const emails = {
    admin: (opts.ownerEmail && opts.ownerEmail.trim().toLowerCase()) || `admin@${domain}`,
    client: `cliente@${domain}`,
    supervisor: `supervisor@${domain}`,
    guardDay: `guardia.dia@${domain}`,
    guardNight: `guardia.noche@${domain}`,
  };
  const ownerName = (opts.ownerFullName && opts.ownerFullName.trim()) || 'Administrador Demo';
  const [ownerFirst, ...ownerRest] = ownerName.split(/\s+/);

  const plan = await getDefaultPlanKey(db).catch(() => 'free');

  // 1) TENANT (Trial tier; trialEndsAt + billingStatus set by the model hook).
  const tenant = await db.tenant.create({
    name: brand,
    url: slug,
    email: emails.admin,
    businessTitle: brand,
    country: 'Ecuador',
    city: 'Guayaquil',
    address: 'Av. Francisco de Orellana y Justino Cornejo',
    postalCode: '090112',
    phone: '+593 4 260 0000',
    latitude: GEO.lat,
    longitude: GEO.lng,
    timezone: 'America/Guayaquil',
    plan,
    taxNumber: `179${crypto.randomBytes(4).toString('hex').replace(/\D/g, '0').slice(0, 7)}001`,
    licenseNumber: 'PN-ECU-DEMO-0001',
    onboardingCompleted: true,
    website: `https://${slug}.cguardpro.com`,
  });
  const tenantId = tenant.id;
  await attachImage(db, db.tenant.getTableName(), 'logo', tenantId, tenantId, brandLogo(brand), 'logo.png');
  const logoFile = await db.file.findOne({ where: { belongsTo: db.tenant.getTableName(), belongsToColumn: 'logo', belongsToId: tenantId } });
  if (logoFile) await tenant.update({ logoId: logoFile.id });

  // 2) SETTINGS — demo-safe: geofence validation OFF, welcome emails OFF.
  const [settings] = await db.settings.findOrCreate({
    where: { tenantId },
    defaults: { id: tenantId, tenantId, theme: 'default' },
  });
  await settings.update({
    nominaSettings: { geofence: { defaultRadiusM: 2000, requireValidation: false, allowOutsideWithApproval: true } },
    clientWelcomeEmailEnabled: false,
  });

  // 3) Built-in roles so 'admin'/'customer'/etc. resolve on membership.
  try {
    const { ensureBuiltInRolesForTenant } = require('../roleSync');
    await ensureBuiltInRolesForTenant(db, tenantId, {});
  } catch { /* non-fatal */ }

  // 4) ADMIN owner.
  const admin = await createUser(db, pwdHash, {
    email: emails.admin, fullName: ownerName, firstName: ownerFirst || 'Admin', lastName: ownerRest.join(' ') || 'Demo',
    phoneNumber: '+593 99 100 0001', avatarUrl: AVATARS.admin,
  });
  await addMembership(db, tenantId, admin.id, ['admin']);

  // 5) CLIENT portal user + clientAccount.
  const clientUser = await createUser(db, pwdHash, {
    email: emails.client, fullName: 'María Torres', firstName: 'María', lastName: 'Torres',
    phoneNumber: '+593 99 100 0002', avatarUrl: AVATARS.client,
  });
  await addMembership(db, tenantId, clientUser.id, ['customer']);
  const client = await db.clientAccount.create({
    tenantId, userId: clientUser.id, name: 'María', lastName: 'Torres', email: emails.client,
    phoneNumber: '+593 99 100 0002', commercialName: `Cliente de ${brand}`, personType: 'PJ',
    documentNumber: '0992233445001', address: 'Av. 9 de Octubre 100 y Malecón', city: 'Guayaquil',
    country: 'Ecuador', zipCode: '090313', latitude: GEO.lat, longitude: GEO.lng,
    onboardingStatus: 'active', active: true,
  });
  await attachImage(db, db.clientAccount.getTableName(), 'logoUrl', client.id, tenantId, brandLogo(`Cliente ${brand}`.slice(0, 20)), 'client-logo.png');

  // 6) SUPERVISOR.
  const supervisor = await createUser(db, pwdHash, {
    email: emails.supervisor, fullName: 'Andrés Pólit', firstName: 'Andrés', lastName: 'Pólit',
    phoneNumber: '+593 99 100 0005', avatarUrl: AVATARS.supervisor,
  });
  await addMembership(db, tenantId, supervisor.id, ['securitySupervisor']);

  // 7) SITE + 3 STATIONS.
  const site = await db.businessInfo.create({
    tenantId, companyName: 'Torre Empresarial', description: 'Edificio corporativo con parqueadero y perímetro vallado.',
    clientAccountId: client.id, contactPhone: '+593 4 260 0001', contactEmail: emails.client,
    latitud: GEO.lat, longitud: GEO.lng, address: 'Av. Francisco de Orellana, Guayaquil',
    city: 'Guayaquil', country: 'Ecuador', postalCode: '090112', serviceType: 'manned', active: true,
  });
  await attachImage(db, db.businessInfo.getTableName(), 'logo', site.id, tenantId, AVATARS.site, 'site.jpg');

  const stationDefs = [
    { stationName: 'Garita Principal', nickname: 'P-01', scheduleType: '24h', dLat: 0, dLng: 0 },
    { stationName: 'Lobby Recepción', nickname: 'P-02', scheduleType: '12h-day', dLat: 0.0004, dLng: 0.0003 },
    { stationName: 'Perímetro Posterior', nickname: 'P-03', scheduleType: '12h-night', dLat: -0.0005, dLng: 0.0006 },
  ];
  const stations: any[] = [];
  for (const d of stationDefs) {
    stations.push(await db.station.create({
      tenantId, postSiteId: site.id, stationName: d.stationName, nickname: d.nickname,
      latitud: GEO.lat + d.dLat, longitud: GEO.lng + d.dLng, geofenceRadius: 2000,
      scheduleType: d.scheduleType, stationSchedule: '12 horas', createdById: admin.id,
    }));
  }
  const mainStation = stations[0];

  // 8) GUARDS (día/noche) — user + membership + securityGuard row.
  async function makeGuard(o: { email: string; fullName: string; firstName: string; lastName: string; phone: string; avatar: string; cedula: string; birth: string; hire: string; }) {
    const user = await createUser(db, pwdHash, { email: o.email, fullName: o.fullName, firstName: o.firstName, lastName: o.lastName, phoneNumber: o.phone, avatarUrl: o.avatar });
    await addMembership(db, tenantId, user.id, ['securityGuard']);
    const guard = await db.securityGuard.create({
      tenantId, guardId: user.id, governmentId: o.cedula, fullName: o.fullName, gender: 'Masculino',
      bloodType: 'O+', birthDate: o.birth, hiringContractDate: o.hire, maritalStatus: 'Casado',
      academicInstruction: 'Secundaria', address: 'Guayaquil, Guayas, Ecuador', latitude: GEO.lat,
      longitude: GEO.lng, guardType: 'titular', isOnDuty: false,
    });
    await attachImage(db, db.securityGuard.getTableName(), 'profileImage', guard.id, tenantId, o.avatar, 'profile.jpg');
    return { user, guard };
  }
  const dia = await makeGuard({ email: emails.guardDay, fullName: 'Juan Ramírez', firstName: 'Juan', lastName: 'Ramírez', phone: '+593 99 100 0003', avatar: AVATARS.guardDay, cedula: '0923456781', birth: '1990-03-15', hire: '2023-01-10' });
  const noche = await makeGuard({ email: emails.guardNight, fullName: 'Pedro Vásquez', firstName: 'Pedro', lastName: 'Vásquez', phone: '+593 99 100 0004', avatar: AVATARS.guardNight, cedula: '0934567892', birth: '1988-07-22', hire: '2022-09-05' });

  // 9) ASSIGNMENTS + assignedGuards junction (so the worker clock-in screen shows the post).
  for (const [g, s, e] of [[dia.user.id, '07:00', '19:00'], [noche.user.id, '19:00', '07:00']] as const) {
    await db.guardAssignment.create({
      tenantId, guardId: g, stationId: mainStation.id, kind: 'adhoc',
      startTime: s, endTime: e, startDate: new Date().toISOString().slice(0, 10), endDate: null, status: 'active',
    });
  }
  try { await mainStation.addAssignedGuards([dia.user.id, noche.user.id]); } catch { /* non-fatal */ }

  // 10) TODAY'S SHIFTS.
  for (const [g, h] of [[dia.user.id, 7], [noche.user.id, 19]] as const) {
    const { start, end } = todayShiftUtc(h, 12);
    await db.shift.create({ tenantId, guardId: g, stationId: mainStation.id, postSiteId: site.id, startTime: start, endTime: end, tzFixed: true, createdById: admin.id });
  }

  // 11) PATROL + CHECKPOINTS.
  const checkpointDefs = [
    { name: 'CP-1 Acceso Principal', dLat: 0.0001, dLng: 0.0001 },
    { name: 'CP-2 Parqueadero', dLat: 0.0003, dLng: -0.0002 },
    { name: 'CP-3 Azotea', dLat: -0.0002, dLng: 0.0004 },
  ];
  const checkpoints: any[] = [];
  for (const d of checkpointDefs) {
    checkpoints.push(await db.patrolCheckpoint.create({
      tenantId, stationId: mainStation.id, name: d.name,
      latitud: GEO.lat + d.dLat, longitud: GEO.lng + d.dLng, createdById: admin.id,
    }));
  }
  const patrol = await db.patrol.create({
    tenantId, stationId: mainStation.id, assignedGuardId: dia.user.id,
    scheduledTime: new Date(), completed: true, status: 'Completed', completionTime: new Date(),
  });
  try { await patrol.setCheckpoints(checkpoints.map((c: any) => c.id)); } catch { /* non-fatal */ }

  const incidentType = await db.incidentType.create({ tenantId, name: 'Persona sospechosa', active: true, createdById: admin.id });

  // ── OPERATIONAL HISTORY (so the sandbox looks like a live operation) ────────
  const now = new Date();

  // 12) PATROL LOG — a completed round (all checkpoints scanned).
  for (const cp of checkpoints) {
    await db.patrolLog.create({
      patrolId: patrol.id, scannedById: dia.user.id, scanTime: now,
      latitude: cp.latitud, longitude: cp.longitud, validLocation: true, status: 'Scanned',
      tenantId, createdById: dia.user.id, updatedById: dia.user.id,
    }, { validate: false });
  }

  // 13) VISITOR LOG.
  try {
    await db.visitorLog.create({
      tenantId, firstName: 'Roberto', lastName: 'Salas', visitorName: 'Ing. Roberto Salas',
      idNumber: '0912345678', company: 'Constructora Salas Cía. Ltda.', reason: 'Reunión con administración',
      purpose: 'Reunión con administración', numPeople: 1, visitDate: now,
      stationId: mainStation.id, postSiteId: site.id, createdById: dia.user.id,
    }, { validate: false });
  } catch { /* non-fatal — schema variance */ }

  // 14) INCIDENTS (2) with photo evidence — direct writes (bypass the assigned-post ACL).
  const incidentDefs = [
    { title: 'Persona sospechosa en el perímetro', description: 'Guardia reporta una persona merodeando junto al acceso vehicular. Se mantiene vigilancia.', priority: 'alta', guard: dia, photo: 'https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=800&q=80' },
    { title: 'Puerta de acceso sin novedad', description: 'Ronda nocturna: acceso posterior verificado y asegurado. Sin novedades.', priority: 'media', guard: noche, photo: 'https://images.unsplash.com/photo-1521790361543-f645cf042ec4?w=800&q=80' },
  ];
  for (const inc of incidentDefs) {
    const rec = await db.incident.create({
      date: now, title: inc.title, description: inc.description, status: 'abierto', priority: inc.priority,
      stationId: mainStation.id, postSiteId: site.id, guardNameId: inc.guard.guard.id, wasRead: false,
      tenantId, createdById: inc.guard.user.id, updatedById: inc.guard.user.id,
    }, { validate: false });
    try { await attachImage(db, db.incident.getTableName(), 'photoUrl', rec.id, tenantId, inc.photo, 'incident.jpg'); } catch { /* non-fatal */ }
  }

  // 15) ATTENDANCE (guardShift) — día ON DUTY now (so the Control Center shows a
  //     live guard + nómina isn't empty), noche a completed shift for history.
  const nowMs = now.getTime();
  const punchInDia = new Date(nowMs - 3 * 3600_000);
  try {
    await db.guardShift.create({
      punchInTime: punchInDia, punchInLatitude: GEO.lat, punchInLongitude: GEO.lng,
      shiftSchedule: 'Diurno', numberOfPatrolsDuringShift: 1, numberOfIncidentsDurindShift: 1,
      observations: 'Turno en curso — sin novedades mayores.',
      sessions: [{ at: punchInDia, lat: GEO.lat, lng: GEO.lng, distanceM: 0 }],
      stationNameId: mainStation.id, guardNameId: dia.guard.id, postSiteId: site.id,
      tenantId, createdById: dia.user.id, updatedById: dia.user.id,
    }, { validate: false });
    await dia.guard.update({ isOnDuty: true });

    const pIn = new Date(nowMs - 20 * 3600_000);
    const pOut = new Date(nowMs - 8 * 3600_000);
    await db.guardShift.create({
      punchInTime: pIn, punchOutTime: pOut, punchInLatitude: GEO.lat, punchInLongitude: GEO.lng,
      shiftSchedule: 'Nocturno', numberOfPatrolsDuringShift: 2, numberOfIncidentsDurindShift: 1,
      observations: 'Turno completado. Perímetro asegurado.',
      sessions: [{ at: pIn, lat: GEO.lat, lng: GEO.lng }, { at: pOut, lat: GEO.lat, lng: GEO.lng, out: true }],
      stationNameId: mainStation.id, guardNameId: noche.guard.id, postSiteId: site.id,
      tenantId, createdById: noche.user.id, updatedById: noche.user.id,
    }, { validate: false });
  } catch { /* non-fatal */ }

  // 16) SHIFT PASSDOWN — a handover (noche → día) received with "Sin novedad".
  try {
    await db.shiftPassdown.create({
      tenantId, stationId: mainStation.id, stationName: mainStation.stationName, postSiteId: site.id,
      outgoingGuardUserId: noche.user.id, outgoingSecurityGuardId: noche.guard.id, outgoingGuardName: 'Pedro Vásquez',
      shiftSchedule: 'Nocturno', shiftKind: 'noche',
      notes: 'Sin novedad. Perímetro y accesos verificados; cámaras operativas. Se entrega llaves y bitácora.',
      instructionCount: 0, status: 'received',
      receivedByGuardUserId: dia.user.id, receivedByName: 'Juan Ramírez', receivedAt: punchInDia,
    }, { validate: false });
  } catch { /* non-fatal */ }

  // 17) RADIO CHECK (pase de novedades) — a completed session + one entry per station.
  try {
    const rc = await db.radioCheckSession.create({
      tenantId, mode: 'manual', initiatedByUserId: supervisor.id, scope: 'all', status: 'completed',
      startedAt: new Date(nowMs - 5 * 3600_000), completedAt: new Date(nowMs - 5 * 3600_000 + 300_000),
      summary: 'Pase de novedades completado. Todas las estaciones responden sin novedad.',
      summaryStatus: 'ready', totalStations: stations.length, respondedCount: stations.length, noResponseCount: 0, incidentCount: 0,
    }, { validate: false });
    let seq = 0;
    for (const st of stations) {
      seq += 1;
      await db.radioCheckEntry.create({
        tenantId, sessionId: rc.id, stationId: st.id, guardUserId: dia.user.id, guardSecurityGuardId: dia.guard.id,
        guardName: 'Juan Ramírez', stationName: st.stationName, seq, status: 'responded',
        promptText: `Central a ${st.stationName}, reporte novedades.`,
        transcript: `Sin novedad en ${st.stationName}. Todo en orden.`,
        transcriptStatus: 'ready', classification: 'sin_novedad',
        respondedAt: new Date(nowMs - 5 * 3600_000 + seq * 20000),
      }, { validate: false });
    }
  } catch { /* non-fatal */ }

  const accounts: SandboxAccount[] = [
    { role: 'Administrador', email: emails.admin, password: sharedPassword, fullName: ownerName },
    { role: 'Cliente (portal)', email: emails.client, password: sharedPassword, fullName: 'María Torres' },
    { role: 'Supervisor', email: emails.supervisor, password: sharedPassword, fullName: 'Andrés Pólit' },
    { role: 'Vigilante (día)', email: emails.guardDay, password: sharedPassword, fullName: 'Juan Ramírez' },
    { role: 'Vigilante (noche)', email: emails.guardNight, password: sharedPassword, fullName: 'Pedro Vásquez' },
  ];

  const result: SandboxResult = {
    tenantId,
    tenantName: brand,
    slug,
    loginUrl: 'https://app.cguardpro.com/login',
    sharedPassword,
    accounts,
  };

  // Optionally email the credentials to the prospect (from demo@cguardpro.com).
  const recipient = (opts.sendCredentialsTo || '').trim();
  if (recipient) {
    const { sent, error } = await emailCredentials(result, recipient);
    result.emailedTo = recipient;
    result.emailSent = sent;
    result.emailError = error || null;
  }

  return result;
}

export default { provisionSandbox };
