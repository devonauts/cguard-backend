/**
 * One-time cleanup: enforce "one turno per station per time slot".
 *
 * The various assignment / manual-turno write paths could leave MULTIPLE active
 * shifts on the same (station, startTime, endTime) slot — different guards stacked
 * on one slot. The rule is one turno per slot, owned by a single guard. This script
 * groups active shifts by (stationId, startTime, endTime) and, for any slot with
 * more than one, keeps a single winner and hard-deletes the rest.
 *
 * Winner preference: a shift linked to a guardAssignment (the authoritative
 * assigned guard) wins; otherwise the most recently created shift.
 *
 * Usage (from backend/, with the same env the app uses):
 *   npx ts-node ./src/scripts/dedupeStationShifts.ts            # dry-run, prints plan
 *   npx ts-node ./src/scripts/dedupeStationShifts.ts --apply    # delete the extras
 */
require('dotenv').config();

import models from '../database/models';

async function main() {
  const apply = process.argv.includes('--apply');
  const database: any = models();
  await database.sequelize.authenticate();

  const shifts = await database.shift.findAll({
    where: { deletedAt: null },
    attributes: ['id', 'stationId', 'guardId', 'guardAssignmentId', 'startTime', 'endTime', 'createdAt'],
  });

  // Group by station + exact time slot. Skip rows with no station (can't belong
  // to a station slot) — those are a separate concern.
  const groups = new Map<string, any[]>();
  for (const s of shifts) {
    const r: any = s.get({ plain: true });
    if (!r.stationId) continue;
    const key = `${r.stationId}|${new Date(r.startTime).getTime()}|${new Date(r.endTime).getTime()}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }

  const toDelete: string[] = [];
  let slotsWithDupes = 0;

  for (const [, list] of groups) {
    if (list.length < 2) continue;
    slotsWithDupes++;
    // Winner: prefer a guardAssignment-linked shift, then the newest.
    list.sort((a, b) => {
      const aLinked = a.guardAssignmentId ? 1 : 0;
      const bLinked = b.guardAssignmentId ? 1 : 0;
      if (aLinked !== bLinked) return bLinked - aLinked;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const [winner, ...losers] = list;
    const st = winner.stationId.slice(0, 8);
    console.log(
      `  slot station ${st}… ${new Date(winner.startTime).toISOString()} → keep ${winner.id.slice(0, 8)} (guard ${String(winner.guardId).slice(0, 8)}), drop ${losers.length}`,
    );
    losers.forEach((l) => toDelete.push(l.id));
  }

  console.log(
    `\n${slotsWithDupes} slot(s) with duplicates, ${toDelete.length} extra shift(s) to remove.`,
  );

  if (apply && toDelete.length) {
    // Hard-delete so the (non-paranoid-aware) unique slot index doesn't keep
    // them around to block future re-creates.
    const removed = await database.shift.destroy({ where: { id: toDelete }, force: true });
    console.log(`Removed ${removed} shift(s).`);
  } else if (toDelete.length) {
    console.log('Dry-run. Re-run with --apply to delete the extras.');
  }

  await database.sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
