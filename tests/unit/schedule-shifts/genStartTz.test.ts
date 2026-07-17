/**
 * Unit test — shift generation floors "today" in the TENANT timezone, not UTC.
 *
 * Regression: a guard assigned "hoy" in Ecuador (UTC-5) in the evening landed on
 * TOMORROW's shift. Cause: computeShiftsForAssignment floored genStart at the
 * SERVER's UTC calendar day; once UTC rolled past midnight (still the same day
 * for the tenant), max(startDate, today) rounded up to tomorrow. Fixed by
 * computing "today" as ymd(now, tenantTz).
 *
 * We freeze the clock at 2026-07-17T02:00:00Z = 2026-07-16 21:00 in Guayaquil,
 * so UTC-today is the 17th but tenant-today is the 16th. An adhoc assignment
 * starting "2026-07-16" must produce its first shift on the 16th.
 *
 * Run:
 *   cross-env NODE_ENV=test TS_NODE_PROJECT=tsconfig.test.json \
 *     npx mocha -r ts-node/register \
 *     'tests/unit/schedule-shifts/genStartTz.test.ts' --exit --timeout 20000
 */

import assert from 'assert';
import sinon from 'sinon';

import { computeShiftsForAssignment } from '../../../src/services/shiftGenerationService';

const TZ = 'America/Guayaquil'; // UTC-5, no DST

// Minimal Sequelize-shaped db: only what computeShiftsForAssignment touches for
// an adhoc assignment (tenant tz + the station lookup).
function buildDb() {
  return {
    tenant: { findByPk: async () => ({ timezone: TZ }) },
    station: { findByPk: async () => ({ postSiteId: 'ps-1', rotationStyleId: null }) },
    rotationStyle: { findByPk: async () => null },
    stationPosition: { findByPk: async () => null },
  } as any;
}

/** Local calendar date of an instant in a tz (mirror of the app's formatting). */
function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

describe('shiftGeneration · genStart is tenant-tz today (not UTC)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => {
    // 2026-07-17T02:00Z → 2026-07-16 21:00 in Guayaquil.
    clock = sinon.useFakeTimers(new Date('2026-07-17T02:00:00Z').getTime());
  });
  afterEach(() => clock.restore());

  it('an adhoc assignment starting the tenant-today date generates a shift TODAY, not tomorrow', async () => {
    const db = buildDb();
    const assignment: any = {
      id: 'a-1',
      guardId: 'g-1',
      stationId: 'st-1',
      positionId: null,
      rotationStyleId: null,
      startDate: '2026-07-16', // tenant-today (the operator's wall-clock day)
      platoonOffset: 0,
      isRelief: false,
      kind: 'adhoc',
      startTime: '07:00',
      endTime: '19:00',
    };

    const shifts = await computeShiftsForAssignment(db, assignment, 'tenant-A');

    assert.ok(shifts.length >= 1, 'should generate at least one shift');
    const first = shifts[0];
    // The first shift must fall on the 16th in the tenant tz — NOT the 17th.
    assert.strictEqual(
      dateInTz(first.startTime, TZ),
      '2026-07-16',
      `first shift should be tenant-today (2026-07-16), got ${dateInTz(first.startTime, TZ)}`,
    );
    // And it starts at 07:00 local.
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(first.startTime);
    assert.strictEqual(hhmm, '07:00');
  });
});
