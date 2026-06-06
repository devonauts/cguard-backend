import { generateShiftsForAssignment } from './shiftGenerationService';

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

  const isAdhoc = !input.positionId;
  const positionId: string | null = input.positionId || null;
  let rotationStyleId: string | null = input.rotationStyleId || null;
  let platoonOffset = 0;
  let isRelief = !!input.isRelief;

  if (!isAdhoc) {
    const position = await database.stationPosition.findByPk(positionId, {
      attributes: ['type', 'platoonOffset'],
    });
    isRelief = !!input.isRelief || position?.type === 'sacafranco';

    // Fijo guards can only be assigned to ONE station.
    if (!isRelief) {
      const existingFijo = await database.guardAssignment.findOne({
        where: { guardId, tenantId, status: 'active', isRelief: false, deletedAt: null, kind: 'rotation' },
        include: [{ model: database.stationPosition, as: 'position', attributes: ['type'], where: { type: 'fijo' } }],
      });
      if (existingFijo) {
        const st = await database.station.findByPk(existingFijo.stationId, { attributes: ['stationName'] });
        throw new AssignmentValidationError(
          `Este guardia ya está asignado como Fijo en "${st?.stationName || 'otra estación'}". Los guardias Fijo solo pueden estar en una estación.`,
        );
      }
    }

    if (!rotationStyleId) {
      const station = await database.station.findByPk(stationId, { attributes: ['rotationStyleId'] });
      rotationStyleId = station?.rotationStyleId || null;
      if (!rotationStyleId) {
        throw new AssignmentValidationError(
          'La estación no tiene un estilo de rotación configurado. Configúrela primero.',
        );
      }
    }

    platoonOffset = input.platoonOffset != null
      ? parseInt(String(input.platoonOffset))
      : (position?.platoonOffset || 0);
  }

  const record = await database.guardAssignment.create({
    guardId,
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
