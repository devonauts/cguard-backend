import { Op } from 'sequelize';

/**
 * Shared no-double-booking predicate. Returns the first existing shift whose time
 * range overlaps [startTime, endTime) for this guard in the tenant, or null.
 * Two ranges overlap iff aStart < bEnd && bStart < aEnd. Use this from EVERY
 * path that writes a shift so overlap enforcement isn't limited to the manual
 * single-shift create/update path.
 */
export async function findGuardShiftOverlap(
  db: any,
  tenantId: string,
  guardId: string | null | undefined,
  startTime: any,
  endTime: any,
  opts: { excludeShiftId?: string; transaction?: any } = {},
): Promise<any | null> {
  if (!guardId || !startTime || !endTime) return null;
  const where: any = {
    tenantId,
    guardId,
    startTime: { [Op.lt]: endTime },
    endTime: { [Op.gt]: startTime },
  };
  if (opts.excludeShiftId) where.id = { [Op.ne]: opts.excludeShiftId };
  return db.shift.findOne({ where, transaction: opts.transaction });
}
