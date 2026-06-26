import { generateShiftsForAssignment } from './shiftGenerationService';
import { resolveGuardUserId } from './guardIdResolver';

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
  startDate: string;               // YYYY-MM-DD
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
  const { guardId, stationId, startDate } = input;
  if (!guardId || !stationId || !startDate) {
    throw new AssignmentValidationError('guardId, stationId and startDate are required');
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

  if (!isAdhoc) {
    const position = await database.stationPosition.findByPk(positionId, {
      attributes: ['type', 'platoonOffset'],
    });
    isRelief = !!input.isRelief || position?.type === 'sacafranco';

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

    platoonOffset = input.platoonOffset != null
      ? parseInt(String(input.platoonOffset))
      : (position?.platoonOffset || 0);

    // Idempotent: one active assignment per (guard, station, position). Re-assigning
    // the same slot reuses the existing row (and refreshes its shifts) instead of
    // creating a duplicate — this also makes the DB-level unique index safe.
    const existing = await database.guardAssignment.findOne({
      where: { guardId: guardUserId, stationId, positionId, tenantId, status: 'active', deletedAt: null },
    });
    if (existing) {
      try {
        await generateShiftsForAssignment(database, existing.get({ plain: true }), tenantId, userId);
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
  // durable source of truth and can always be regenerated.
  try {
    await generateShiftsForAssignment(database, record.get({ plain: true }), tenantId, userId);
  } catch (genErr) {
    console.error('[createAssignment] shift generation error:', genErr);
  }

  return record;
}
