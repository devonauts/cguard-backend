/**
 * Sandbox provisioner — spins up a fresh, prospect-branded, fully-populated
 * TRIAL tenant on demand (superadmin → Sandboxes). Sales hands the login to a
 * prospect as a personalized, data-rich demo/leave-behind.
 *
 * SELF-CONTAINED BY DESIGN: reproduces a realistic multi-client security
 * operation using the SAME proven model-write patterns as the demo seed /
 * orchestrator, but NEVER touches the live-demo tenant. Every sandbox is a
 * brand-new tenant (unique slug + emails) with its own isolated data.
 *
 * Generates (default 20 clients): for EACH client → client portal account +
 * site + 2 stations + 2 guards + schedule + assignments, plus operational
 * history (a día guard ON DUTY, a completed patrol round, an incident w/ photo,
 * a visitor, a shift-passdown). Plus a global supervisor + a radio-check across
 * every client. Images throughout (logos, site photos, guard/user avatars,
 * incident photos). On the Trial tier so the paywall/entitlements apply.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDefaultPlanKey } from '../planCatalogService';
import { sendMail } from '../mailService';

type Db = any;

/** From-address for sandbox credential emails. Override with SANDBOX_EMAIL_FROM. */
const SANDBOX_EMAIL_FROM =
  process.env.SANDBOX_EMAIL_FROM || 'CGuardPro Demo <demo@cguardpro.com>';

const BCRYPT_ROUNDS = 12;
const DEFAULT_CLIENTS = 20;
const MAX_CLIENTS = 40;

// ── Content pools (Ecuadorian flavour) ──────────────────────────────────────
const COMPANIES = [
  'Comercial Pacífico S.A.', 'Banco del Litoral', 'Clínica Kennedy', 'Mall del Sol',
  'Universidad Espíritu Santo', 'Hotel Oro Verde', 'Condominio Bellavista', 'Industrias Ales',
  'Corporación Favorita', 'Cervecería Nacional', 'Almacenes De Prati', 'Farmacias Cruz Azul',
  'Constructora Etinar', 'Plásticos del Litoral', 'Grupo Difare', 'Pronaca',
  'Holcim Ecuador', 'La Fabril', 'Nestlé Ecuador', 'Claro Ecuador',
  'Banco Bolivariano', 'Supermaxi Norte', 'Tecnología Andina', 'Puerto Marítimo GYE',
  'Automotores Continental', 'Textiles del Pacífico', 'Agrícola San Juan', 'Distribuidora Andes',
  'Seguros Equinoccial', 'Molinos Nacionales', 'Cemento Chimborazo', 'Frigoríficos del Sur',
  'Papelera Nacional', 'Vidriería Guayas', 'Metalúrgica Litoral', 'Logística Portuaria',
  'Hospital Alcívar', 'Centro Médico Sur', 'Colegio San Luis', 'Torre Financiera',
];
const SITE_TYPES = [
  'Torre Empresarial', 'Planta Industrial', 'Bodega Central', 'Edificio Corporativo',
  'Centro Comercial', 'Sucursal', 'Campus', 'Complejo Residencial',
];
const FIRST_M = ['Juan', 'Pedro', 'Luis', 'Carlos', 'Andrés', 'Jorge', 'Diego', 'Marco', 'Fernando', 'Roberto', 'Miguel', 'José', 'Byron', 'Christian', 'David', 'Esteban', 'Freddy', 'Gabriel', 'Héctor', 'Iván'];
const FIRST_F = ['María', 'Ana', 'Gabriela', 'Verónica', 'Daniela', 'Paola', 'Andrea', 'Carmen', 'Cristina', 'Diana'];
const LAST = ['Ramírez', 'Vásquez', 'Méndez', 'Torres', 'Pólit', 'Cedeño', 'Zambrano', 'Bravo', 'Mora', 'Castillo', 'Vera', 'Intriago', 'Loor', 'Palacios', 'Andrade', 'Villacís', 'Suárez', 'Herrera', 'Ponce', 'Chávez', 'Delgado', 'Salazar', 'Guerrero', 'Franco'];
const CITIES = [
  { name: 'Guayaquil', lat: -2.170998, lng: -79.922359 },
  { name: 'Quito', lat: -0.180653, lng: -78.467834 },
  { name: 'Cuenca', lat: -2.900128, lng: -79.005896 },
  { name: 'Manta', lat: -0.967653, lng: -80.708910 },
  { name: 'Machala', lat: -3.258620, lng: -79.960530 },
  { name: 'Ambato', lat: -1.241650, lng: -78.619200 },
  { name: 'Santo Domingo', lat: -0.253000, lng: -79.175000 },
  { name: 'Portoviejo', lat: -1.054540, lng: -80.454460 },
];
const STATION_NAMES = ['Garita Principal', 'Lobby Recepción', 'Perímetro Posterior', 'Acceso Vehicular', 'Parqueadero', 'Torre de Control'];
const INCIDENTS = [
  { title: 'Persona sospechosa en el perímetro', description: 'Guardia reporta una persona merodeando junto al acceso vehicular. Se mantiene vigilancia.', priority: 'alta', photo: 'https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=800&q=80' },
  { title: 'Acceso verificado sin novedad', description: 'Ronda de verificación: acceso posterior asegurado. Sin novedades.', priority: 'media', photo: 'https://images.unsplash.com/photo-1521790361543-f645cf042ec4?w=800&q=80' },
  { title: 'Vehículo mal estacionado', description: 'Se detecta un vehículo obstruyendo la salida de emergencia. Se notifica a administración.', priority: 'media', photo: 'https://images.unsplash.com/photo-1494783367193-149034c05e8f?w=800&q=80' },
  { title: 'Corte de energía en el sector', description: 'Falla eléctrica temporal; se activa planta de emergencia. Perímetro sin afectación.', priority: 'baja', photo: 'https://images.unsplash.com/photo-1509395176047-4a66953fd231?w=800&q=80' },
];
const AVATARS_M = ['men/32.jpg', 'men/41.jpg', 'men/54.jpg', 'men/76.jpg', 'men/12.jpg', 'men/22.jpg', 'men/85.jpg', 'men/64.jpg', 'men/3.jpg', 'men/91.jpg'];
const AVATARS_F = ['women/68.jpg', 'women/44.jpg', 'women/21.jpg', 'women/33.jpg', 'women/12.jpg', 'women/57.jpg'];
const SITE_PHOTOS = [
  'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&q=80',
  'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&q=80',
  'https://images.unsplash.com/photo-1449157291145-7efd050a4d0e?w=800&q=80',
  'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&q=80',
];

const pick = <T>(a: T[], i: number): T => a[((i % a.length) + a.length) % a.length];
const rint = (n: number): number => crypto.randomInt(Math.max(1, n));
const jit = (): number => (crypto.randomInt(400) - 200) / 10000; // ±0.02°

function slugify(s: string): string {
  return String(s || 'prospecto').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'prospecto';
}
function brandLogo(name: string): string {
  const bg = ['0D47A1', '00695C', '4A148C', 'B71C1C', 'E65100', '1B5E20'][rint(6)];
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(String(name || 'Demo').slice(0, 22))}&background=${bg}&color=fff&size=256`;
}
const avatarM = (i: number) => `https://randomuser.me/api/portraits/${pick(AVATARS_M, i)}`;
const avatarF = (i: number) => `https://randomuser.me/api/portraits/${pick(AVATARS_F, i)}`;

async function attachImage(db: Db, belongsTo: string, col: string, id: string, tenantId: string, publicUrl: string, name: string): Promise<void> {
  await db.file.destroy({ where: { belongsTo, belongsToColumn: col, belongsToId: id }, force: true });
  await db.file.create({ belongsTo, belongsToColumn: col, belongsToId: id, name, publicUrl, sizeInBytes: 0, mimeType: 'image/jpeg', tenantId });
}

const _colCache: Record<string, Set<string>> = {};
async function columnExists(db: Db, table: string, col: string): Promise<boolean> {
  if (!_colCache[table]) {
    try { _colCache[table] = new Set(Object.keys(await db.sequelize.getQueryInterface().describeTable(table))); }
    catch { _colCache[table] = new Set(); }
  }
  return _colCache[table].has(col);
}

async function createUser(db: Db, pwdHash: string, o: { email: string; fullName: string; firstName: string; lastName: string; phoneNumber: string; avatarUrl: string }): Promise<any> {
  const base: any = { email: o.email.toLowerCase(), password: pwdHash, fullName: o.fullName, firstName: o.firstName, lastName: o.lastName, phoneNumber: o.phoneNumber, emailVerified: true };
  if (await columnExists(db, 'users', 'avatarUrl')) base.avatarUrl = o.avatarUrl;
  return db.user.create(base);
}
const addMembership = (db: Db, tenantId: string, userId: string, roles: string[]) => db.tenantUser.create({ userId, tenantId, roles, status: 'active' });

/** Today's UTC window for a 12h shift given a local start hour (Ecuador = UTC-5). */
function todayShiftUtc(localStartHour: number, durationH = 12): { start: Date; end: Date } {
  const OFFSET = 5;
  const localNow = new Date(Date.now() - OFFSET * 3600_000);
  const start = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), localStartHour + OFFSET, 0, 0));
  return { start, end: new Date(start.getTime() + durationH * 3600_000) };
}

export interface SandboxAccount { role: string; email: string; password: string; fullName: string; }
export interface SandboxStats { clients: number; guards: number; stations: number; onDutyGuards: number; incidents: number; }
export interface SandboxResult {
  tenantId: string;
  tenantName: string;
  slug: string;
  loginUrl: string;
  sharedPassword: string;
  accounts: SandboxAccount[];
  stats: SandboxStats;
  emailedTo?: string | null;
  emailSent?: boolean;
  emailError?: string | null;
}
export interface ProvisionOpts {
  brandName: string;
  ownerEmail?: string | null;
  ownerFullName?: string | null;
  clientCount?: number;
  sendCredentialsTo?: string | null;
}

const esc = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function credentialsEmailHtml(r: SandboxResult): string {
  const rows = r.accounts.map((a) => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#111">${esc(a.role)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;color:#333">${esc(a.email)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;color:#333">${esc(a.password)}</td></tr>`).join('');
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">
    <h2 style="color:#0D47A1;margin-bottom:4px">Tu demo de CGuardPro está lista</h2>
    <p style="margin-top:0;color:#555">Preparamos un entorno de prueba para <b>${esc(r.tenantName)}</b> con
    <b>${r.stats.clients} clientes</b>, <b>${r.stats.guards} guardias</b> y ${r.stats.stations} puestos —
    ya cargado con turnos, rondas, incidentes y novedades para que lo explores como una operación real.</p>
    <p style="margin:20px 0"><a href="${esc(r.loginUrl)}" style="background:#0D47A1;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Ingresar a la plataforma</a></p>
    <p style="color:#555;margin-bottom:6px">Accesos principales (todas las cuentas usan la misma contraseña):</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="background:#f5f7fa">
    <th style="text-align:left;padding:8px 12px;color:#555">Rol</th><th style="text-align:left;padding:8px 12px;color:#555">Correo</th><th style="text-align:left;padding:8px 12px;color:#555">Contraseña</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="color:#888;font-size:12px;margin-top:24px">Entorno de prueba de CGuardPro. Si no solicitaste esta demo, ignora este correo.</p>
  </div>`;
}

async function emailCredentials(r: SandboxResult, to: string): Promise<{ sent: boolean; error?: string }> {
  try {
    await sendMail({ to, from: SANDBOX_EMAIL_FROM, subject: `Tu demo de CGuardPro — ${r.tenantName}`, html: credentialsEmailHtml(r) });
    return { sent: true };
  } catch (e: any) { return { sent: false, error: e?.message || 'mail send failed' }; }
}

/** Provision a fully-populated, branded multi-client trial sandbox. */
export async function provisionSandbox(db: Db, opts: ProvisionOpts): Promise<SandboxResult> {
  const brand = String(opts.brandName || '').trim();
  if (!brand) throw new Error('brandName is required');
  const clientCount = Math.min(MAX_CLIENTS, Math.max(1, Number(opts.clientCount) || DEFAULT_CLIENTS));

  const slug = `${slugify(brand)}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 45);
  const domain = `${slug}.sandbox.cguardpro.com`;
  const sharedPassword = `Demo-${crypto.randomBytes(3).toString('hex')}A1`;
  const pwdHash = bcrypt.hashSync(sharedPassword, BCRYPT_ROUNDS);
  const adminEmail = (opts.ownerEmail && opts.ownerEmail.trim().toLowerCase()) || `admin@${domain}`;
  const ownerName = (opts.ownerFullName && opts.ownerFullName.trim()) || 'Administrador Demo';
  const [ownerFirst, ...ownerRest] = ownerName.split(/\s+/);
  const hq = CITIES[0];
  const plan = await getDefaultPlanKey(db).catch(() => 'free');
  const nowMs = Date.now();

  // 1) TENANT.
  const tenant = await db.tenant.create({
    name: brand, url: slug, email: adminEmail, businessTitle: brand, country: 'Ecuador', city: hq.name,
    address: 'Av. Francisco de Orellana y Justino Cornejo', postalCode: '090112', phone: '+593 4 260 0000',
    latitude: hq.lat, longitude: hq.lng, timezone: 'America/Guayaquil', plan,
    taxNumber: `179${crypto.randomBytes(4).toString('hex').replace(/\D/g, '0').slice(0, 7)}001`,
    licenseNumber: 'PN-ECU-DEMO-0001', onboardingCompleted: true, website: `https://${slug}.cguardpro.com`,
  });
  const tenantId = tenant.id;
  await attachImage(db, db.tenant.getTableName(), 'logo', tenantId, tenantId, brandLogo(brand), 'logo.png');
  const logoFile = await db.file.findOne({ where: { belongsTo: db.tenant.getTableName(), belongsToColumn: 'logo', belongsToId: tenantId } });
  if (logoFile) await tenant.update({ logoId: logoFile.id });

  // 2) SETTINGS — demo-safe.
  const [settings] = await db.settings.findOrCreate({ where: { tenantId }, defaults: { id: tenantId, tenantId, theme: 'default' } });
  await settings.update({ nominaSettings: { geofence: { defaultRadiusM: 2000, requireValidation: false, allowOutsideWithApproval: true } }, clientWelcomeEmailEnabled: false });

  // 3) Built-in roles.
  try { await require('../roleSync').ensureBuiltInRolesForTenant(db, tenantId, {}); } catch { /* non-fatal */ }

  // 4) ADMIN + SUPERVISOR (global).
  const admin = await createUser(db, pwdHash, { email: adminEmail, fullName: ownerName, firstName: ownerFirst || 'Admin', lastName: ownerRest.join(' ') || 'Demo', phoneNumber: '+593 99 100 0001', avatarUrl: avatarM(0) });
  await addMembership(db, tenantId, admin.id, ['admin']);
  const supervisor = await createUser(db, pwdHash, { email: `supervisor@${domain}`, fullName: 'Andrés Pólit', firstName: 'Andrés', lastName: 'Pólit', phoneNumber: '+593 99 100 0005', avatarUrl: avatarM(2) });
  await addMembership(db, tenantId, supervisor.id, ['securitySupervisor']);

  const incidentType = await db.incidentType.create({ tenantId, name: 'Novedad operativa', active: true, createdById: admin.id });

  let guardCounter = 0;
  let onDuty = 0;
  let incidentCount = 0;
  const mainStationIds: string[] = [];
  const stationLabels: Record<string, string> = {};
  let sampleClient: SandboxAccount | null = null;
  let sampleGuard: SandboxAccount | null = null;

  // 5) CLIENTS loop.
  for (let ci = 0; ci < clientCount; ci++) {
    const city = pick(CITIES, ci);
    const clat = city.lat + jit();
    const clng = city.lng + jit();
    const company = pick(COMPANIES, ci);
    const repFirst = pick(FIRST_F, ci);
    const repLast = pick(LAST, ci + 3);
    const clientEmail = `cliente${ci + 1}@${domain}`;

    const clientUser = await createUser(db, pwdHash, { email: clientEmail, fullName: `${repFirst} ${repLast}`, firstName: repFirst, lastName: repLast, phoneNumber: `+593 99 2${String(ci).padStart(2, '0')} 000`, avatarUrl: avatarF(ci) });
    await addMembership(db, tenantId, clientUser.id, ['customer']);
    const client = await db.clientAccount.create({
      tenantId, userId: clientUser.id, name: repFirst, lastName: repLast, email: clientEmail,
      phoneNumber: `+593 99 2${String(ci).padStart(2, '0')} 000`, commercialName: company, personType: 'PJ',
      documentNumber: `099${String(1000000 + ci).slice(-7)}001`, address: `Av. Principal ${100 + ci}`, city: city.name,
      country: 'Ecuador', zipCode: '090150', latitude: clat, longitude: clng, onboardingStatus: 'active', active: true,
    });
    await attachImage(db, db.clientAccount.getTableName(), 'logoUrl', client.id, tenantId, brandLogo(company), 'client-logo.png');

    const site = await db.businessInfo.create({
      tenantId, companyName: `${pick(SITE_TYPES, ci)} ${company.split(' ')[0]}`, description: 'Instalación con perímetro vallado y control de accesos.',
      clientAccountId: client.id, contactPhone: `+593 4 26${String(ci).padStart(2, '0')} 00`, contactEmail: clientEmail,
      latitud: clat, longitud: clng, address: `Av. Principal ${100 + ci}, ${city.name}`, city: city.name, country: 'Ecuador',
      postalCode: '090112', serviceType: 'manned', active: true,
    });
    await attachImage(db, db.businessInfo.getTableName(), 'logo', site.id, tenantId, pick(SITE_PHOTOS, ci), 'site.jpg');

    // 2 stations.
    const stations: any[] = [];
    for (let si = 0; si < 2; si++) {
      stations.push(await db.station.create({
        tenantId, postSiteId: site.id, stationName: pick(STATION_NAMES, ci + si), nickname: `P-${ci + 1}${si + 1}`,
        latitud: clat + jit() / 4, longitud: clng + jit() / 4, geofenceRadius: 2000,
        scheduleType: si === 0 ? '24h' : '12h-day', stationSchedule: '12 horas', createdById: admin.id,
      }));
    }
    const mainStation = stations[0];
    mainStationIds.push(mainStation.id);
    stationLabels[mainStation.id] = mainStation.stationName;

    // 2 guards (día/noche).
    const guards: any[] = [];
    for (let gi = 0; gi < 2; gi++) {
      guardCounter += 1;
      const gf = pick(FIRST_M, guardCounter);
      const gl = pick(LAST, guardCounter);
      const gUser = await createUser(db, pwdHash, { email: `g${ci + 1}-${gi + 1}@${domain}`, fullName: `${gf} ${gl}`, firstName: gf, lastName: gl, phoneNumber: `+593 98 ${String(guardCounter).padStart(3, '0')} 00`, avatarUrl: avatarM(guardCounter) });
      await addMembership(db, tenantId, gUser.id, ['securityGuard']);
      const guard = await db.securityGuard.create({
        tenantId, guardId: gUser.id, governmentId: `09${String(10000000 + guardCounter).slice(-8)}`, fullName: `${gf} ${gl}`,
        gender: 'Masculino', bloodType: pick(['O+', 'A+', 'B+', 'O-'], guardCounter), birthDate: `19${85 + (guardCounter % 12)}-0${1 + (guardCounter % 8)}-1${guardCounter % 9}`,
        hiringContractDate: `202${2 + (guardCounter % 3)}-0${1 + (guardCounter % 8)}-05`, maritalStatus: pick(['Casado', 'Soltero'], guardCounter),
        academicInstruction: 'Secundaria', address: `${city.name}, Ecuador`, latitude: clat, longitude: clng, guardType: 'titular', isOnDuty: false,
      });
      await attachImage(db, db.securityGuard.getTableName(), 'profileImage', guard.id, tenantId, avatarM(guardCounter), 'profile.jpg');
      // Assignment + today's shift.
      await db.guardAssignment.create({ tenantId, guardId: gUser.id, stationId: mainStation.id, kind: 'adhoc', startTime: gi === 0 ? '07:00' : '19:00', endTime: gi === 0 ? '19:00' : '07:00', startDate: new Date().toISOString().slice(0, 10), endDate: null, status: 'active' });
      const { start, end } = todayShiftUtc(gi === 0 ? 7 : 19, 12);
      await db.shift.create({ tenantId, guardId: gUser.id, stationId: mainStation.id, postSiteId: site.id, startTime: start, endTime: end, tzFixed: true, createdById: admin.id });
      guards.push({ user: gUser, guard });
    }
    try { await mainStation.addAssignedGuards(guards.map((g) => g.user.id)); } catch { /* non-fatal */ }
    const dia = guards[0], noche = guards[1];

    // ATTENDANCE — día ON DUTY now, noche completed last night.
    const punchInDia = new Date(nowMs - (2 + rint(4)) * 3600_000);
    try {
      await db.guardShift.create({
        punchInTime: punchInDia, punchInLatitude: clat, punchInLongitude: clng, shiftSchedule: 'Diurno',
        numberOfPatrolsDuringShift: 1, numberOfIncidentsDurindShift: 1, observations: 'Turno en curso — sin novedades mayores.',
        sessions: [{ at: punchInDia, lat: clat, lng: clng, distanceM: 0 }], stationNameId: mainStation.id,
        guardNameId: dia.guard.id, postSiteId: site.id, tenantId, createdById: dia.user.id, updatedById: dia.user.id,
      }, { validate: false });
      await dia.guard.update({ isOnDuty: true });
      onDuty += 1;
      const pIn = new Date(nowMs - 20 * 3600_000), pOut = new Date(nowMs - 8 * 3600_000);
      await db.guardShift.create({
        punchInTime: pIn, punchOutTime: pOut, punchInLatitude: clat, punchInLongitude: clng, shiftSchedule: 'Nocturno',
        numberOfPatrolsDuringShift: 2, numberOfIncidentsDurindShift: 0, observations: 'Turno completado. Perímetro asegurado.',
        sessions: [{ at: pIn, lat: clat, lng: clng }, { at: pOut, lat: clat, lng: clng, out: true }], stationNameId: mainStation.id,
        guardNameId: noche.guard.id, postSiteId: site.id, tenantId, createdById: noche.user.id, updatedById: noche.user.id,
      }, { validate: false });
    } catch { /* non-fatal */ }

    // RONDA — real siteTour + checkpoints (siteTourTag) + completed scans (tagScan).
    // (The old patrol/patrolLog system is retired; rondas live in siteTour/tagScan.)
    try {
      const tour = await db.siteTour.create({ name: 'Ronda perimetral', description: 'Recorrido de seguridad del puesto', stationId: mainStation.id, postSiteId: site.id, securityGuardId: dia.guard.id, tenantId, createdById: admin.id }, { validate: false });
      const assignment = await db.tourAssignment.create({ siteTourId: tour.id, securityGuardId: dia.guard.id, stationId: mainStation.id, status: 'completed', startAt: new Date(nowMs - 3 * 3600_000), endAt: new Date(nowMs - rint(2) * 3600_000), tenantId, createdById: admin.id }, { validate: false });
      for (let k = 0; k < 3; k++) {
        const cpName = `CP-${k + 1} ${pick(['Acceso', 'Parqueadero', 'Azotea', 'Perímetro'], k)}`;
        const tag = await db.siteTourTag.create({ name: cpName, tagIdentifier: `DEMO-CP-${k + 1}-${String(mainStation.id).slice(0, 8)}`, siteTourId: tour.id, latitude: clat + jit() / 3, longitude: clng + jit() / 3, tenantId, createdById: admin.id }, { validate: false });
        await db.tagScan.create({ scannedAt: new Date(nowMs - rint(3) * 3600_000), siteTourTagId: tag.id, tourAssignmentId: assignment.id, securityGuardId: dia.guard.id, stationId: mainStation.id, validLocation: true, tenantId, createdById: dia.user.id, updatedById: dia.user.id }, { validate: false });
      }
    } catch { /* non-fatal */ }

    // INCIDENT (with photo) for most clients.
    if (ci % 4 !== 3) {
      try {
        const idf = pick(INCIDENTS, ci);
        const rec = await db.incident.create({ date: new Date(nowMs - rint(24) * 3600_000), title: idf.title, description: idf.description, status: 'abierto', priority: idf.priority, stationId: mainStation.id, postSiteId: site.id, guardNameId: dia.guard.id, wasRead: ci % 2 === 0, tenantId, createdById: dia.user.id, updatedById: dia.user.id }, { validate: false });
        await attachImage(db, db.incident.getTableName(), 'photoUrl', rec.id, tenantId, idf.photo, 'incident.jpg');
        incidentCount += 1;
      } catch { /* non-fatal */ }
    }

    // VISITOR.
    try {
      const vf = pick(FIRST_M, ci + 5), vl = pick(LAST, ci + 7);
      await db.visitorLog.create({ tenantId, firstName: vf, lastName: vl, visitorName: `Ing. ${vf} ${vl}`, idNumber: `09${String(20000000 + ci).slice(-8)}`, company: pick(COMPANIES, ci + 10), reason: 'Reunión con administración', purpose: 'Reunión con administración', numPeople: 1 + (ci % 3), visitDate: new Date(nowMs - rint(12) * 3600_000), stationId: mainStation.id, postSiteId: site.id, createdById: dia.user.id }, { validate: false });
    } catch { /* non-fatal */ }

    // SHIFT PASSDOWN (handover).
    try {
      await db.shiftPassdown.create({ tenantId, stationId: mainStation.id, stationName: mainStation.stationName, postSiteId: site.id, outgoingGuardUserId: noche.user.id, outgoingSecurityGuardId: noche.guard.id, outgoingGuardName: noche.guard.fullName, shiftSchedule: 'Nocturno', shiftKind: 'noche', notes: 'Sin novedad. Perímetro y accesos verificados; cámaras operativas.', instructionCount: 0, status: 'received', receivedByGuardUserId: dia.user.id, receivedByName: dia.guard.fullName, receivedAt: punchInDia }, { validate: false });
    } catch { /* non-fatal */ }

    if (ci === 0) {
      sampleClient = { role: 'Cliente (portal)', email: clientEmail, password: sharedPassword, fullName: `${repFirst} ${repLast}` };
      sampleGuard = { role: 'Vigilante (ejemplo)', email: `g1-1@${domain}`, password: sharedPassword, fullName: dia.guard.fullName };
    }
  }

  // 6) RADIO CHECK — one session across every client's main station.
  try {
    const rc = await db.radioCheckSession.create({ tenantId, mode: 'manual', initiatedByUserId: supervisor.id, scope: 'all', status: 'completed', startedAt: new Date(nowMs - 5 * 3600_000), completedAt: new Date(nowMs - 5 * 3600_000 + 600_000), summary: 'Pase de novedades completado. Estaciones responden sin novedad.', summaryStatus: 'ready', totalStations: mainStationIds.length, respondedCount: mainStationIds.length, noResponseCount: 0, incidentCount: 0 }, { validate: false });
    let seq = 0;
    for (const sid of mainStationIds) {
      seq += 1;
      await db.radioCheckEntry.create({ tenantId, sessionId: rc.id, stationId: sid, guardName: 'Vigilante', stationName: stationLabels[sid] || 'Puesto', seq, status: 'responded', promptText: `Central a ${stationLabels[sid]}, reporte novedades.`, transcript: 'Sin novedad. Todo en orden.', transcriptStatus: 'ready', classification: 'sin_novedad', respondedAt: new Date(nowMs - 5 * 3600_000 + seq * 15000) }, { validate: false });
    }
  } catch { /* non-fatal */ }

  const accounts: SandboxAccount[] = [
    { role: 'Administrador (principal)', email: adminEmail, password: sharedPassword, fullName: ownerName },
    { role: 'Supervisor', email: `supervisor@${domain}`, password: sharedPassword, fullName: 'Andrés Pólit' },
  ];
  if (sampleClient) accounts.push(sampleClient);
  if (sampleGuard) accounts.push(sampleGuard);

  const result: SandboxResult = {
    tenantId, tenantName: brand, slug, loginUrl: 'https://app.cguardpro.com/login', sharedPassword, accounts,
    stats: { clients: clientCount, guards: guardCounter, stations: clientCount * 2, onDutyGuards: onDuty, incidents: incidentCount },
  };

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
