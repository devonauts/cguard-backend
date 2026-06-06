/**
 * ⚠️ DESTRUCTIVE, ONE-TIME — wipes ALL attendance data for EVERY tenant.
 *
 * Deletes every row from: guardShifts, attendanceExceptions,
 * attendanceCorrections, clockOutRequests (hard delete, bypassing paranoid).
 * This is intentionally a standalone script (NOT a migration) so it never runs
 * automatically on deploy.
 *
 * Run:  npx ts-node scripts/wipe-attendance.ts --confirm
 */
require('dotenv').config();

import models from '../src/database/models';

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error(
      '\nRefusing to wipe without --confirm.\n' +
        'This deletes ALL attendance records for ALL tenants.\n' +
        'Re-run as:  npx ts-node scripts/wipe-attendance.ts --confirm\n',
    );
    process.exit(1);
  }

  const db = models();

  // Children first (no enforced FKs, but tidy), then the records themselves.
  const order = [
    'clockOutRequest',
    'attendanceCorrection',
    'attendanceException',
    'guardShift',
  ];

  for (const name of order) {
    const model = db[name];
    if (!model) {
      console.warn(`(skip) model ${name} not found`);
      continue;
    }
    const n = await model.destroy({ where: {}, force: true });
    console.log(`✓ ${name}: deleted ${n} row(s)`);
  }

  console.log('\n✅ attendance wiped clean.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
