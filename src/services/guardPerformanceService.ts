import { Op } from 'sequelize';

/**
 * Guard Performance Score
 * =======================
 * Produces an explainable 0–100 performance score for a security guard over a
 * rolling period, plus a per-component breakdown, key stats and actionable tips.
 *
 * The score is a weighted average of up to five components. Components without
 * enough data to judge are dropped and the remaining weights are renormalized,
 * so a brand-new guard isn't punished for a lack of history.
 *
 *   attendance   0.30  — worked shifts vs scheduled shifts
 *   punctuality  0.25  — clock-in time vs scheduled start (grace + decay)
 *   completion   0.20  — clocked out + hours worked vs scheduled hours
 *   patrols      0.15  — patrols performed vs expected per shift
 *   reporting    0.10  — shifts with logged observations / activity
 *
 * Everything is derived from records the guard already generates
 * (guardShift punches + scheduled shifts), so no extra tracking is required.
 */

export type ComponentKey =
  | 'attendance'
  | 'punctuality'
  | 'completion'
  | 'patrols'
  | 'reporting';

export type Tier = 'excellent' | 'good' | 'fair' | 'needs_improvement';

const WEIGHTS: Record<ComponentKey, number> = {
  attendance: 0.3,
  punctuality: 0.25,
  completion: 0.2,
  patrols: 0.15,
  reporting: 0.1,
};

// Tuning knobs (overridable via env).
const GRACE_MIN = Number(process.env.GUARD_PUNCTUALITY_GRACE_MIN) || 5;
const LATE_FLOOR_MIN = Number(process.env.GUARD_PUNCTUALITY_FLOOR_MIN) || 30;
const EXPECTED_PATROLS_PER_SHIFT =
  Number(process.env.GUARD_EXPECTED_PATROLS_PER_SHIFT) || 4;
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000; // worked↔scheduled pairing window

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const hours = (a: any, b: any) =>
  Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000);

function tierFor(score: number): Tier {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'needs_improvement';
}

export default class GuardPerformanceService {
  private req: any;
  constructor(req: any) {
    this.req = req;
  }

  private get db() {
    return this.req.database;
  }
  private get tenantId() {
    return (
      this.req.params?.tenantId ||
      (this.req.currentTenant && this.req.currentTenant.id)
    );
  }

  /** Performance for the authenticated guard (resolved from their user id). */
  async forUser(userId: string, periodDays = 30) {
    const securityGuard = await this.db.securityGuard.findOne({
      where: { guardId: userId, tenantId: this.tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    return this.compute({ userId, securityGuard, periodDays });
  }

  /** Performance for a specific securityGuard record (supervisor view). */
  async forSecurityGuard(securityGuardId: string, periodDays = 30) {
    const securityGuard = await this.db.securityGuard.findOne({
      where: { id: securityGuardId, tenantId: this.tenantId, deletedAt: null },
      attributes: ['id', 'fullName', 'guardId'],
    });
    return this.compute({
      userId: securityGuard?.guardId,
      securityGuard,
      periodDays,
    });
  }

  private async compute({
    userId,
    securityGuard,
    periodDays,
  }: {
    userId?: string;
    securityGuard: any;
    periodDays: number;
  }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const now = new Date();
    const from = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // Worked shifts (clock-in records) in the period.
    const worked: any[] = securityGuard
      ? (
          await db.guardShift.findAll({
            where: {
              guardNameId: securityGuard.id,
              tenantId,
              punchInTime: { [Op.gte]: from, [Op.lte]: now },
            },
            order: [['punchInTime', 'ASC']],
          })
        ).map((r: any) => r.get({ plain: true }))
      : [];

    // Scheduled shifts in the period.
    const scheduled: any[] = userId
      ? (
          await db.shift.findAll({
            where: {
              guardId: userId,
              tenantId,
              startTime: { [Op.gte]: from, [Op.lte]: now },
            },
            attributes: ['id', 'startTime', 'endTime', 'stationId'],
            order: [['startTime', 'ASC']],
          })
        ).map((r: any) => r.get({ plain: true }))
      : [];

    const shiftsWorked = worked.length;
    const shiftsScheduled = scheduled.length;

    // --- pair each worked shift with the closest scheduled shift ---
    const latenesses: number[] = [];
    const completionScores: number[] = [];
    let onTimeShifts = 0;
    let hoursWorked = 0;

    for (const w of worked) {
      const punchIn = new Date(w.punchInTime).getTime();
      if (w.punchOutTime) hoursWorked += hours(w.punchInTime, w.punchOutTime);

      // nearest scheduled shift within the window
      let best: any = null;
      let bestDelta = Infinity;
      for (const s of scheduled) {
        const delta = Math.abs(new Date(s.startTime).getTime() - punchIn);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = s;
        }
      }
      const matched = best && bestDelta <= MATCH_WINDOW_MS ? best : null;

      if (matched) {
        const lateMin =
          (punchIn - new Date(matched.startTime).getTime()) / 60000;
        latenesses.push(lateMin);
        if (lateMin <= GRACE_MIN) onTimeShifts++;

        // completion: worked hours vs scheduled hours (needs punch-out)
        if (w.punchOutTime) {
          const schedHrs = hours(matched.startTime, matched.endTime) || 1;
          const workedHrs = hours(w.punchInTime, w.punchOutTime);
          completionScores.push(clamp((workedHrs / schedHrs) * 100));
        } else {
          // shift ended but never punched out → abandoned
          const ended = new Date(matched.endTime).getTime() < now.getTime();
          completionScores.push(ended ? 30 : 100);
        }
      } else if (w.punchOutTime) {
        completionScores.push(100);
      }
    }

    // --- component scores (null = not enough data) ---
    const scores: Partial<Record<ComponentKey, number>> = {};

    // attendance
    if (shiftsScheduled > 0) {
      scores.attendance = clamp((shiftsWorked / shiftsScheduled) * 100);
    } else if (shiftsWorked > 0) {
      scores.attendance = 100;
    }

    // punctuality
    if (latenesses.length > 0) {
      const per = latenesses.map((late) => {
        if (late <= GRACE_MIN) return 100;
        if (late >= LATE_FLOOR_MIN) return 0;
        return clamp(
          100 - ((late - GRACE_MIN) / (LATE_FLOOR_MIN - GRACE_MIN)) * 100
        );
      });
      scores.punctuality = clamp(
        per.reduce((a, b) => a + b, 0) / per.length
      );
    }

    // completion
    if (completionScores.length > 0) {
      scores.completion = clamp(
        completionScores.reduce((a, b) => a + b, 0) / completionScores.length
      );
    }

    // patrols
    const patrolsDone = worked.reduce(
      (sum, w) => sum + (Number(w.numberOfPatrolsDuringShift) || 0),
      0
    );
    if (shiftsWorked > 0) {
      const expected = shiftsWorked * EXPECTED_PATROLS_PER_SHIFT;
      scores.patrols = clamp((patrolsDone / expected) * 100);
    }

    // reporting (engagement): shifts with observations logged
    const incidentsReported = worked.reduce(
      (sum, w) => sum + (Number(w.numberOfIncidentsDurindShift) || 0),
      0
    );
    if (shiftsWorked > 0) {
      const withObs = worked.filter(
        (w) => w.observations && String(w.observations).trim().length > 0
      ).length;
      scores.reporting = clamp((withObs / shiftsWorked) * 100);
    }

    // --- weighted overall (renormalize over available components) ---
    let weightSum = 0;
    let acc = 0;
    const components = (Object.keys(WEIGHTS) as ComponentKey[])
      .filter((k) => scores[k] != null)
      .map((k) => {
        const score = Math.round(scores[k] as number);
        weightSum += WEIGHTS[k];
        acc += (scores[k] as number) * WEIGHTS[k];
        return { key: k, score, weight: WEIGHTS[k] };
      });

    const overall = weightSum > 0 ? Math.round(acc / weightSum) : 0;
    const tier = tierFor(overall);

    // --- actionable tips for the weakest components ---
    const tips: ComponentKey[] = [];
    if ((scores.attendance ?? 100) < 90) tips.push('attendance');
    if ((scores.punctuality ?? 100) < 90) tips.push('punctuality');
    if ((scores.completion ?? 100) < 90) tips.push('completion');
    if ((scores.patrols ?? 100) < 80) tips.push('patrols');
    if ((scores.reporting ?? 100) < 80) tips.push('reporting');

    const avgLatenessMin = latenesses.length
      ? Math.round(
          (latenesses.reduce((a, b) => a + Math.max(0, b), 0) /
            latenesses.length) *
            10
        ) / 10
      : 0;

    return {
      generatedAt: now.toISOString(),
      period: { days: periodDays, from: from.toISOString(), to: now.toISOString() },
      guard: securityGuard
        ? { id: securityGuard.id, fullName: securityGuard.fullName }
        : null,
      score: overall,
      tier,
      hasData: components.length > 0,
      components,
      stats: {
        hoursWorked: Math.round(hoursWorked * 10) / 10,
        shiftsScheduled,
        shiftsWorked,
        onTimeShifts,
        attendanceRate:
          shiftsScheduled > 0
            ? Math.round((shiftsWorked / shiftsScheduled) * 100)
            : null,
        avgLatenessMin,
        patrolsDone,
        incidentsReported,
      },
      tips,
    };
  }
}
