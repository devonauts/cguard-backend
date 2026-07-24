/**
 * SCHEDULE INTEGRITY AUDIT — a read-only sweep that surfaces the classes of
 * scheduling-data corruption that historically caused "el horario muestra mal"
 * bugs (a guard's shifts leaking onto the wrong station; turnos surviving after a
 * guard was removed; a fijo whose assignment offset drifted from its position so
 * its rest day lands on the wrong weekday).
 *
 * It NEVER mutates data — detection only. The generator (`generateShiftsForAssignment`)
 * self-heals the leak/phantom classes on the next regeneration; this audit makes
 * the problem VISIBLE in the superadmin observability panel before a client calls.
 *
 * Runs daily via the leader-elected scheduler (see server.ts) and is also queried
 * live by GET /superadmin/observability/integrity.
 */
import { createNotification } from './superadmin/superadminNotificationService';

export interface IntegritySample {
  tenantId?: string | null;
  label: string;
  detail: string;
}

export interface IntegrityFindings {
  mismatchedStationShifts: number;
  phantomShiftsOnEndedAssignments: number;
  offsetDriftAssignments: number;
  total: number;
  samples: {
    mismatch: IntegritySample[];
    phantom: IntegritySample[];
    drift: IntegritySample[];
  };
  scannedAt: string;
}

// Resolve the REAL table names from the models (never hard-code — respects any
// explicit tableName + the active dialect's quoting).
function tables(db: any) {
  const name = (m: any): string => {
    const t = m.getTableName();
    return typeof t === 'string' ? t : t.tableName;
  };
  return {
    shifts: name(db.shift),
    guardAssignments: name(db.guardAssignment),
    stationPositions: name(db.stationPosition),
    stations: name(db.station),
    users: name(db.user),
  };
}

async function count(db: any, sql: string, replacements: any): Promise<number> {
  const rows: any[] = await db.sequelize.query(sql, {
    type: db.Sequelize.QueryTypes.SELECT,
    replacements,
  });
  return Number(rows?.[0]?.n || 0);
}

async function rows(db: any, sql: string, replacements: any): Promise<any[]> {
  return db.sequelize.query(sql, { type: db.Sequelize.QueryTypes.SELECT, replacements });
}

/**
 * Compute the three integrity checks. Pure read — safe to call from the panel on
 * every load (uses indexed joins + LIMITed samples).
 */
export async function computeIntegrityFindings(db: any): Promise<IntegrityFindings> {
  const t = tables(db);
  const now = new Date();
  // Quote table identifiers per dialect so camelCase table names survive on
  // case-sensitive MySQL (prod) as well as Postgres/sqlite (dev/test).
  const dialect = String(db.sequelize.getDialect());
  const qc = dialect === 'mysql' || dialect === 'mariadb' ? '`' : '"';
  const q = (id: string) => `${qc}${id}${qc}`;
  const S = q(t.shifts), GA = q(t.guardAssignments), SP = q(t.stationPositions), ST = q(t.stations), U = q(t.users);

  // 1) Cross-station leak: a NON-relief shift whose station ≠ its assignment's
  //    station. Relief/global sacafrancos legitimately cover other stations.
  const mismatchWhere = `s.deletedAt IS NULL AND ga.isRelief = false AND s.stationId IS NOT NULL AND s.stationId <> ga.stationId`;
  const mismatchedStationShifts = await count(
    db,
    `SELECT COUNT(*) AS n FROM ${S} s JOIN ${GA} ga ON ga.id = s.guardAssignmentId WHERE ${mismatchWhere}`,
    {},
  );
  const mismatchRows = await rows(
    db,
    `SELECT COUNT(*) AS n, s.tenantId AS tenantId, s.stationId AS onStation, ga.stationId AS ownStation,
            gu.fullName AS guardName, sON.stationName AS onStationName, sOWN.stationName AS ownStationName
       FROM ${S} s
       JOIN ${GA} ga ON ga.id = s.guardAssignmentId
       LEFT JOIN ${U} gu ON gu.id = s.guardId
       LEFT JOIN ${ST} sON ON sON.id = s.stationId
       LEFT JOIN ${ST} sOWN ON sOWN.id = ga.stationId
      WHERE ${mismatchWhere}
      GROUP BY s.stationId, ga.stationId, gu.fullName, sON.stationName, sOWN.stationName, s.tenantId
      LIMIT 8`,
    {},
  );

  // 2) Phantom shifts: a live future shift whose parent assignment is ended or
  //    soft-deleted (the guard was removed but the turno lingers).
  const phantomWhere = `s.deletedAt IS NULL AND s.endTime > :now AND (ga.status = 'ended' OR ga.deletedAt IS NOT NULL)`;
  const phantomShiftsOnEndedAssignments = await count(
    db,
    `SELECT COUNT(*) AS n FROM ${S} s JOIN ${GA} ga ON ga.id = s.guardAssignmentId WHERE ${phantomWhere}`,
    { now },
  );
  const phantomRows = await rows(
    db,
    `SELECT COUNT(*) AS n, s.tenantId AS tenantId, gu.fullName AS guardName, st.stationName AS stationName
       FROM ${S} s
       JOIN ${GA} ga ON ga.id = s.guardAssignmentId
       LEFT JOIN ${U} gu ON gu.id = s.guardId
       LEFT JOIN ${ST} st ON st.id = s.stationId
      WHERE ${phantomWhere}
      GROUP BY gu.fullName, st.stationName, s.tenantId
      LIMIT 8`,
    { now },
  );

  // 3) Offset drift: an active fijo rotation whose assignment.platoonOffset ≠ its
  //    position.platoonOffset. They must stay in sync — otherwise a re-assign
  //    silently re-phases the guard (this is exactly what put a rest day on the
  //    wrong weekday). Only fijos with a live position.
  const driftWhere = `ga.deletedAt IS NULL AND ga.status = 'active' AND ga.isRelief = false AND ga.kind = 'rotation' AND sp.deletedAt IS NULL AND ga.platoonOffset <> sp.platoonOffset`;
  const offsetDriftAssignments = await count(
    db,
    `SELECT COUNT(*) AS n FROM ${GA} ga JOIN ${SP} sp ON sp.id = ga.positionId WHERE ${driftWhere}`,
    {},
  );
  const driftRows = await rows(
    db,
    `SELECT ga.tenantId AS tenantId, ga.platoonOffset AS asgOffset, sp.platoonOffset AS posOffset,
            gu.fullName AS guardName, st.stationName AS stationName
       FROM ${GA} ga
       JOIN ${SP} sp ON sp.id = ga.positionId
       LEFT JOIN ${U} gu ON gu.id = ga.guardId
       LEFT JOIN ${ST} st ON st.id = ga.stationId
      WHERE ${driftWhere}
      LIMIT 8`,
    {},
  );

  const findings: IntegrityFindings = {
    mismatchedStationShifts,
    phantomShiftsOnEndedAssignments,
    offsetDriftAssignments,
    total: mismatchedStationShifts + phantomShiftsOnEndedAssignments + offsetDriftAssignments,
    samples: {
      mismatch: mismatchRows.map((r: any) => ({
        tenantId: r.tenantId,
        label: r.guardName || 'Vigilante',
        detail: `${Number(r.n)} turno(s) en "${r.onStationName || '—'}" pero pertenece a "${r.ownStationName || '—'}"`,
      })),
      phantom: phantomRows.map((r: any) => ({
        tenantId: r.tenantId,
        label: r.guardName || 'Vigilante',
        detail: `${Number(r.n)} turno(s) futuros en "${r.stationName || '—'}" de una asignación ya terminada`,
      })),
      drift: driftRows.map((r: any) => ({
        tenantId: r.tenantId,
        label: r.guardName || 'Vigilante',
        detail: `"${r.stationName || '—'}": offset asignación ${r.asgOffset} ≠ puesto ${r.posOffset}`,
      })),
    },
    scannedAt: now.toISOString(),
  };
  return findings;
}

// Only raise a fresh panel notification twice a day at most — the counts change
// slowly and we don't want a wall of alerts on every tick.
let lastFiredAt = 0;
const FINDING_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Daily sweep entrypoint (called by the leader-elected scheduler via runJob).
 * Computes the findings and, when something is wrong, persists ONE superadmin
 * notification (cooldown-guarded) linking to the observability panel.
 */
export async function runIntegrityAudit(db?: any): Promise<void> {
  const database = db || require('../database/models').default();
  if (!database?.shift || !database?.guardAssignment) return;

  const findings = await computeIntegrityFindings(database);
  if (findings.total <= 0) return;

  if (Date.now() - lastFiredAt < FINDING_COOLDOWN_MS) return;
  lastFiredAt = Date.now();

  const parts: string[] = [];
  if (findings.mismatchedStationShifts) parts.push(`${findings.mismatchedStationShifts} turno(s) en estación equivocada`);
  if (findings.phantomShiftsOnEndedAssignments) parts.push(`${findings.phantomShiftsOnEndedAssignments} turno(s) de asignaciones terminadas`);
  if (findings.offsetDriftAssignments) parts.push(`${findings.offsetDriftAssignments} rotación(es) con offset desalineado`);

  await createNotification(database, {
    type: 'integrity.schedule',
    title: 'Integridad de horarios: se detectaron inconsistencias',
    body: parts.join(' · '),
    link: '/observability/integrity',
    icon: 'AlertTriangle',
    metadata: {
      mismatchedStationShifts: findings.mismatchedStationShifts,
      phantomShiftsOnEndedAssignments: findings.phantomShiftsOnEndedAssignments,
      offsetDriftAssignments: findings.offsetDriftAssignments,
      samples: findings.samples,
      scannedAt: findings.scannedAt,
    },
  });
}
