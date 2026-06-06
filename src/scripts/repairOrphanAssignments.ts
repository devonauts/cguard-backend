/**
 * One-time repair: rebind orphaned guard assignments to a real station position.
 *
 * Background: the station / guard-profile "Assign Guard" flow used to create
 * `guardAssignment` rows with kind='adhoc' and positionId=null. The Horario grid
 * renders strictly per position (assignment.positionId === position.id), so those
 * rows are invisible there and the puesto shows as "faltan". The write path is now
 * fixed (postSiteAssignGuard.ts resolves an open puesto), but rows created before
 * the fix are still orphaned. This script finds them and rebinds each to the first
 * open puesto of the matching type at its station, then regenerates its shifts.
 *
 * Usage (from backend/, with the same env the app uses):
 *   npx ts-node ./src/scripts/repairOrphanAssignments.ts            # dry-run, prints plan
 *   npx ts-node ./src/scripts/repairOrphanAssignments.ts --apply    # actually applies
 */
require('dotenv').config();

import models from '../database/models';
import { generateShiftsForAssignment } from '../services/shiftGenerationService';

async function main() {
  const apply = process.argv.includes('--apply');
  const database: any = models();
  await database.sequelize.authenticate();

  // Orphaned = active, kind='adhoc' (or null), and no positionId → invisible in Horario.
  const orphans = await database.guardAssignment.findAll({
    where: {
      status: 'active',
      deletedAt: null,
      positionId: null,
      kind: 'adhoc',
    },
  });

  console.log(`Found ${orphans.length} orphaned assignment(s) (active, positionId=null).`);
  if (!orphans.length) {
    await database.sequelize.close();
    return;
  }

  let fixed = 0;
  let skipped = 0;

  for (const a of orphans) {
    const row: any = a.get({ plain: true });
    const { id, tenantId, stationId, guardId } = row;

    const station = await database.station.findByPk(stationId, {
      attributes: ['id', 'stationName', 'rotationStyleId'],
    });
    if (!station) {
      console.log(`  - SKIP ${id}: station ${stationId} not found`);
      skipped++;
      continue;
    }

    const sg = await database.securityGuard.findOne({
      where: { guardId, tenantId, deletedAt: null },
      attributes: ['guardType', 'fullName'],
    });
    const desiredType = sg?.guardType === 'sacafranco' ? 'sacafranco' : 'fijo';

    const stationPositions = await database.stationPosition.findAll({
      where: { stationId, tenantId, deletedAt: null },
      attributes: ['id', 'name', 'type', 'sortOrder', 'platoonOffset'],
      order: [['sortOrder', 'ASC']],
    });
    if (!stationPositions.length) {
      console.log(`  - SKIP ${id}: "${station.stationName}" has no positions configured`);
      skipped++;
      continue;
    }

    const occupied = new Set(
      (await database.guardAssignment.findAll({
        where: { stationId, tenantId, status: 'active', deletedAt: null },
        attributes: ['positionId'],
      }))
        .map((x: any) => x.positionId)
        .filter(Boolean),
    );
    const ofType = stationPositions.filter((p: any) => p.type === desiredType);
    const pool = ofType.length
      ? ofType
      : stationPositions.filter((p: any) => p.type !== 'sacafranco');
    const target: any = pool.find((p: any) => !occupied.has(p.id)) || pool[0];
    if (!target) {
      console.log(`  - SKIP ${id}: no suitable puesto at "${station.stationName}"`);
      skipped++;
      continue;
    }

    const isRelief = target.type === 'sacafranco';
    console.log(
      `  - ${apply ? 'FIX ' : 'PLAN'} ${id}: ${sg?.fullName || guardId} → "${station.stationName}" / puesto "${target.name}" (${target.type})${occupied.has(target.id) ? ' [OVERSTAFFED — all puestos full]' : ''}`,
    );

    if (apply) {
      await database.guardAssignment.update(
        {
          kind: 'rotation',
          positionId: target.id,
          rotationStyleId: station.rotationStyleId || row.rotationStyleId,
          platoonOffset: target.platoonOffset || 0,
          isRelief,
          startTime: null,
          endTime: null,
        },
        { where: { id, tenantId } },
      );
      const updated = await database.guardAssignment.findByPk(id);
      try {
        await generateShiftsForAssignment(database, updated.get({ plain: true }), tenantId, row.updatedById || row.createdById);
      } catch (e) {
        console.error(`    shift regen error for ${id}:`, e);
      }
      fixed++;
    }
  }

  console.log(
    apply
      ? `\nDone. Repaired ${fixed}, skipped ${skipped}.`
      : `\nDry-run. Would repair ${orphans.length - skipped}, skip ${skipped}. Re-run with --apply to commit.`,
  );
  await database.sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
