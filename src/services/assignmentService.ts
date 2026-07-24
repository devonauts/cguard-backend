import { generateShiftsForAssignment, MAX_ASSIGNMENT_HORIZON_DAYS } from './shiftGenerationService';
import { resolveGuardUserId } from './guardIdResolver';
import { ymd } from './consignaRecurrence';

/** Today's calendar date (YYYY-MM-DD) in the tenant's timezone (never UTC). */
export async function tenantToday(database: any, tenantId: string): Promise<string> {
  try {
    const t = await database.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    return ymd(new Date(), (t && t.timezone) || 'UTC');
  } catch {
    return ymd(new Date(), 'UTC');
  }
}

/**
 * THE single write path for guard ↔ station assignments.
 *
 * Both the Horario rotation endpoint (`guardAssignmentCreate`) and the manual
 * post-site / guard-profile screens funnel through here, so every assignment
 * lands in `guardAssignment` (the single source of truth) and auto-generates
 * the concrete `shifts` that every other surface reads. No screen writes a raw
 * shift or a side-table anymore.
 *
 *  - kind='rotation' : driven by a station position + rotation style (Horario).
 *  - kind='adhoc'    : a manual one-off with an explicit HH:mm window.
 */

export interface CreateAssignmentInput {
  guardId: string;                 // users.id
  stationId: string;
  positionId?: string | null;      // present ⇒ rotation; absent ⇒ adhoc
  rotationStyleId?: string | null;
  startDate?: string;              // YYYY-MM-DD (optional ⇒ defaults to today; phase comes from the position)
  endDate?: string | null;         // YYYY-MM-DD (null ⇒ indefinite rotation / single-day adhoc)
  startTime?: string | null;       // HH:mm (adhoc only)
  endTime?: string | null;         // HH:mm (adhoc only)
  platoonOffset?: number | null;
  isRelief?: boolean;
}

/** Thrown for caller-facing validation problems (HTTP 400). */
export class AssignmentValidationError extends Error {
  httpStatus = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentValidationError';
  }
}

export async function createAssignment(
  database: any,
  tenantId: string,
  userId: string,
  input: CreateAssignmentInput,
) {
  const { guardId, stationId } = input;
  if (!guardId || !stationId) {
    throw new AssignmentValidationError('guardId and stationId are required');
  }
  // The rotation PHASE comes from the station position, not from a start date, so a
  // start date is no longer required — a guard "dropped into" a station follows the
  // station's horario from today. startDate only bounds when shifts begin.
  // "Today" MUST be the tenant's calendar day, not the server's UTC day: on a
  // UTC server past tenant-midnight, a UTC default (or a naive floor) pushed a
  // guard assigned "hoy" onto tomorrow's shift.
  const startDate = input.startDate || (await tenantToday(database, tenantId));

  // Validate startDate like endDate below: a malformed value ('Invalid date',
  // a bad string) otherwise reached the DATE column and MySQL 500'd with
  // "Incorrect DATE value" instead of a clean 400. (Only when caller-supplied;
  // the tenantToday default is always valid.)
  if (input.startDate && isNaN(new Date(startDate).getTime())) {
    throw new AssignmentValidationError('La fecha de inicio no es válida (usa el formato YYYY-MM-DD).');
  }

  // Bound the generation window at the API boundary: endDate must parse, must not
  // precede startDate, and must stay within the yearly generation horizon. A
  // typo'd year (e.g. 9999-12-31) would otherwise drive a multi-million-day
  // shift-generation walk + bulkCreate. The generator also clamps defensively.
  if (input.endDate) {
    const end = new Date(input.endDate);
    if (isNaN(end.getTime())) {
      throw new AssignmentValidationError('La fecha de fin no es válida (usa el formato YYYY-MM-DD).');
    }
    const start = new Date(startDate);
    if (!isNaN(start.getTime()) && end < start) {
      throw new AssignmentValidationError('La fecha de fin no puede ser anterior a la fecha de inicio.');
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const genStart = !isNaN(start.getTime()) && start > today ? start : today;
    const maxEnd = new Date(genStart.getTime() + MAX_ASSIGNMENT_HORIZON_DAYS * 24 * 60 * 60 * 1000);
    if (end > maxEnd) {
      throw new AssignmentValidationError(
        `La fecha de fin no puede superar el horizonte de generación de ${MAX_ASSIGNMENT_HORIZON_DAYS} días (máximo ${maxEnd.toISOString().slice(0, 10)}).`,
      );
    }
  }

  // Resolve the incoming guard reference (a user id OR a securityGuard id from
  // the autocomplete) to the underlying users.id. The assignment and every
  // shift generated from it must key on the same id the guard's worker-app
  // queries by (`shift.guardId = currentUser.id`); otherwise the turnos are
  // silently orphaned and never appear. Fail loudly on an unmatched guard.
  const { userId: guardUserId } = await resolveGuardUserId(database, tenantId, guardId);
  if (!guardUserId) {
    throw new AssignmentValidationError(
      'El vigilante seleccionado no es válido o no pertenece a este inquilino.',
    );
  }

  const isAdhoc = !input.positionId;
  const positionId: string | null = input.positionId || null;
  // The patrón de rotación belongs to the STATION (station.rotationStyleId) and is
  // inherited at shift generation — a guard assignment never carries its own.
  // Any incoming input.rotationStyleId is intentionally ignored.
  const rotationStyleId: string | null = null;
  let platoonOffset = 0;
  let isRelief = !!input.isRelief;
  let manualSf = false; // sacafranco rotation assignments skip auto shift-generation

  if (!isAdhoc) {
    const position = await database.stationPosition.findByPk(positionId, {
      attributes: ['type', 'platoonOffset'],
    });
    isRelief = !!input.isRelief || position?.type === 'sacafranco';
    // MANUAL SACAFRANCO (2026-07-18): assigning a guard to a sacafranco puesto
    // NO LONGER auto-generates the SF rotation. The SF starts with an empty
    // month (todo libre) and coverage is placed by hand from Programador ›
    // Horario (drag a día of the SF onto a puesto's L → ad-hoc shift), or in
    // bulk by the explicit "Optimizar Sacafrancos" action, which plans and
    // regenerates via generateShiftsForAssignment directly (not this path).
    manualSf = isRelief;

    // A guard may hold at most ONE active rotation assignment (fijo OR sacafranco).
    // Stacking (fijo+fijo, fijo+relief, relief+relief) double-books the guard and
    // destroys their rest day — the core promise. Re-assigning the SAME slot is
    // handled idempotently below, so only a DIFFERENT active rotation slot blocks.
    const existingRotation = await database.guardAssignment.findOne({
      where: { guardId: guardUserId, tenantId, status: 'active', deletedAt: null, kind: 'rotation' },
    });
    if (
      existingRotation &&
      !(existingRotation.stationId === stationId && existingRotation.positionId === positionId)
    ) {
      const st = await database.station.findByPk(existingRotation.stationId, { attributes: ['stationName'] });
      const roleTxt = existingRotation.isRelief ? 'Sacafranco' : 'Fijo';
      throw new AssignmentValidationError(
        `Este vigilante ya tiene una asignación activa (${roleTxt} en "${st?.stationName || 'otra estación'}"). Un vigilante solo puede tener una asignación de rotación a la vez.`,
      );
    }

    // The station must have a patrón de rotación configured (shift generation
    // inherits it). We only validate it exists — we never copy it onto the assignment.
    const station = await database.station.findByPk(stationId, { attributes: ['rotationStyleId'] });
    if (!station?.rotationStyleId) {
      throw new AssignmentValidationError(
        'La estación no tiene un patrón de rotación configurado. Configúralo en la estación (Horario del turno) antes de asignar.',
      );
    }

    // PHASE = START DATE, ALWAYS. The rotation cycle's day-0 (the guard's FIRST work
    // day) is simply their startDate: "lo agrego para el día 20 ⇒ el ciclo D/N/L
    // arranca el 20". There is no epoch-relative stagger anymore — the start date is
    // the single control; to stagger two guards you just give them different start
    // dates. platoonOffset is now nothing more than the phase derived from startDate.
    //
    // Only SACAFRANCO (relief) is left untouched: it doesn't auto-generate shifts on
    // this path (manualSf) and its coverage is placed by hand / the SF planner.
    platoonOffset = position?.platoonOffset || 0;

    if (position && position.type !== 'sacafranco') {
      const stFull = await database.station.findByPk(stationId, { attributes: ['rotationStyleId'] });
      if (stFull?.rotationStyleId) {
        const rot = await database.rotationStyle.findByPk(stFull.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
        const cycle = (rot?.dayShifts || 0) + (rot?.nightShifts || 0) + (rot?.restDays || 0);
        if (cycle > 0) {
          // offset ≡ dse(startDate) (mod cycle). startDate is the tenant-local calendar
          // date; dse uses the same 2024-01-01 epoch the generator uses.
          const dseStart = Math.floor((Date.parse(`${String(startDate).slice(0, 10)}T00:00:00Z`) - Date.UTC(2024, 0, 1)) / 86400000);
          if (Number.isFinite(dseStart)) platoonOffset = ((dseStart % cycle) + cycle) % cycle;
        }
      }
    }

    // Idempotent: one active assignment per (guard, station, position). Re-assigning
    // the same slot reuses the existing row (and refreshes its shifts) instead of
    // creating a duplicate — this also makes the DB-level unique index safe.
    const existing = await database.guardAssignment.findOne({
      where: { guardId: guardUserId, stationId, positionId, tenantId, status: 'active', deletedAt: null },
    });
    if (existing) {
      try {
        // Re-phase the reused row too (a re-assign with a new startDate must move
        // the guard's first work day — alternation offset above is date-driven).
        if (existing.platoonOffset !== platoonOffset || (input.startDate && existing.startDate !== startDate)) {
          await existing.update({ platoonOffset, startDate });
        }
        if (!manualSf) {
          await generateShiftsForAssignment(database, existing.get({ plain: true }), tenantId, userId);
        }
      } catch (genErr) {
        console.error('[createAssignment] reuse regen error:', genErr);
      }
      return existing;
    }
  }

  // No double-booking via the ADHOC path. Rotation assignments are guarded above
  // (one active rotation per guard); adhoc previously bypassed every check, so a
  // guard could be assigned to two stations at once. Reject when the guard
  // already has an active assignment at a DIFFERENT station whose date range
  // overlaps this one. (Range overlap: existing.start <= new.end AND
  // (existing.end IS NULL OR existing.end >= new.start).)
  if (isAdhoc) {
    const Op = database.Sequelize.Op;
    const newStart = startDate;
    const newEnd = input.endDate || startDate;
    const conflict = await database.guardAssignment.findOne({
      where: {
        guardId: guardUserId,
        tenantId,
        status: 'active',
        deletedAt: null,
        stationId: { [Op.ne]: stationId },
        startDate: { [Op.lte]: newEnd },
        [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: newStart } }],
      },
    });
    if (conflict) {
      const st = await database.station.findByPk(conflict.stationId, { attributes: ['stationName'] });
      throw new AssignmentValidationError(
        `Este vigilante ya tiene una asignación activa en "${st?.stationName || 'otra estación'}" que se solapa con estas fechas. Un vigilante no puede tener dos asignaciones al mismo tiempo.`,
      );
    }
  }

  const record = await database.guardAssignment.create({
    guardId: guardUserId,
    stationId,
    kind: isAdhoc ? 'adhoc' : 'rotation',
    positionId,
    rotationStyleId,
    startDate,
    endDate: input.endDate || null,
    startTime: isAdhoc ? (input.startTime || null) : null,
    endTime: isAdhoc ? (input.endTime || null) : null,
    platoonOffset,
    isRelief,
    status: 'active',
    tenantId,
    createdById: userId,
    updatedById: userId,
  });

  // Auto-generate the concrete shifts. Best-effort: the assignment row is the
  // durable source of truth and can always be regenerated. Manual sacafrancos
  // skip this — their coverage is placed day-by-day (or via the optimizer).
  if (!manualSf) {
    try {
      await generateShiftsForAssignment(database, record.get({ plain: true }), tenantId, userId);
    } catch (genErr) {
      console.error('[createAssignment] shift generation error:', genErr);
    }
  }

  return record;
}
