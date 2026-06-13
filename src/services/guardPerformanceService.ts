import { Op } from 'sequelize';
import { isDueOn } from './consignaRecurrence';

/**
 * Guard / Supervisor Performance Score
 * ====================================
 * Produces an explainable 1–100 performance score for a security guard OR a
 * supervisor over a rolling period, plus a per-factor breakdown, key stats and
 * actionable tips.
 *
 * The score combines EIGHT factors. Seven are positive "quality / compliance"
 * factors that form a weighted base; the eighth (faltas y atrasos) is handled
 * specially as a LOGARITHMIC penalty so the first missed shift hurts the most
 * and each subsequent one hurts a little less. A capped "backup" bonus rewards
 * volunteering for and covering shifts.
 *
 *   base100 = 100 * Σ(w_i · s_i) / Σ(w_i)          (over factors with data)
 *   penalty = K · ln(1 + A·absences + B·tardies)   (faltas y atrasos)
 *   bonus   = min(VOL·volunteers + COVER·covers, CAP)
 *   score   = clamp(base100 − penalty + bonus, 1, 100)
 *
 * Factors lacking data are dropped and the remaining weights renormalized, so a
 * brand-new hire isn't punished for a lack of history. Supervisors have no
 * securityGuard record, so guard-only factors (inventory, consignas, training)
 * simply drop for them.
 *
 * Weighted factors:
 *   punctuality 0.18  — clock-in time vs scheduled start (grace + decay)
 *   uniform     0.14  — supervisor uniform-inspection ratings
 *   inventory   0.14  — complete daily inventory checks
 *   consignas   0.16  — station consignas completed vs due
 *   rondas      0.16  — patrols completed vs scheduled/expected
 *   quiz        0.12  — station security-test score
 *   training    0.10  — tutorials completed vs assigned
 */

export type ComponentKey =
  | 'punctuality'
  | 'uniform'
  | 'inventory'
  | 'consignas'
  | 'rondas'
  | 'quiz'
  | 'training';

export type Tier = 'excellent' | 'good' | 'fair' | 'needs_improvement';
export type SubjectType = 'guard' | 'supervisor';

const DEFAULT_WEIGHTS: Record<ComponentKey, number> = {
  punctuality: 0.18,
  uniform: 0.14,
  inventory: 0.14,
  consignas: 0.16,
  rondas: 0.16,
  quiz: 0.12,
  training: 0.1,
};

const num = (v: any, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Defaults (overridable via env, then per-tenant performanceSettings).
const ENV = {
  graceMin: num(process.env.GUARD_PUNCTUALITY_GRACE_MIN, 5),
  lateFloorMin: num(process.env.GUARD_PUNCTUALITY_FLOOR_MIN, 30),
  expectedPatrols: num(process.env.GUARD_EXPECTED_PATROLS_PER_SHIFT, 4),
  penaltyK: num(process.env.PERF_PENALTY_K, 22),
  penaltyA: num(process.env.PERF_PENALTY_A, 1.0),
  penaltyB: num(process.env.PERF_PENALTY_B, 0.35),
  // Forced clock-out (shift ended without the guard closing it). Light weight —
  // lower than a tardy.
  penaltyC: num(process.env.PERF_PENALTY_C, 0.18),
  volPts: num(process.env.PERF_VOLUNTEER_PTS, 1),
  coverPts: num(process.env.PERF_COVER_PTS, 4),
  bonusCap: num(process.env.PERF_BONUS_CAP, 12),
};

const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000; // worked↔scheduled pairing window
const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const hours = (a: any, b: any) =>
  Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000);
const mean = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function tierFor(score: number): Tier {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'needs_improvement';
}

interface Knobs {
  weights: Record<ComponentKey, number>;
  graceMin: number;
  lateFloorMin: number;
  expectedPatrols: number;
  penaltyK: number;
  penaltyA: number;
  penaltyB: number;
  penaltyC: number;
  volPts: number;
  coverPts: number;
  bonusCap: number;
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
    return this.compute({
      subjectUserId: userId,
      securityGuard,
      subjectType: 'guard',
      periodDays,
    });
  }

  /** Performance for a specific securityGuard record (supervisor view). */
  async forSecurityGuard(securityGuardId: string, periodDays = 30) {
    const securityGuard = await this.db.securityGuard.findOne({
      where: { id: securityGuardId, tenantId: this.tenantId, deletedAt: null },
      attributes: ['id', 'fullName', 'guardId'],
    });
    return this.compute({
      subjectUserId: securityGuard?.guardId,
      securityGuard,
      subjectType: 'guard',
      periodDays,
    });
  }

  /**
   * Performance for a supervisor (a staff user with no securityGuard record).
   * Guard-only factors (inventory, consignas, training) drop and renormalize.
   */
  async forSupervisor(userId: string, periodDays = 30) {
    // A supervisor may still have a guard record in some tenants; use it if so.
    const securityGuard = await this.db.securityGuard.findOne({
      where: { guardId: userId, tenantId: this.tenantId, deletedAt: null },
      attributes: ['id', 'fullName'],
    });
    return this.compute({
      subjectUserId: userId,
      securityGuard,
      subjectType: 'supervisor',
      periodDays,
    });
  }

  /** Load tenant knob overrides, falling back to env then hardcoded defaults. */
  private async loadKnobs(): Promise<Knobs> {
    let row: any = null;
    try {
      if (this.db.performanceSettings) {
        row = await this.db.performanceSettings.findOne({
          where: { tenantId: this.tenantId, active: true, deletedAt: null },
        });
        row = row ? row.get({ plain: true }) : null;
      }
    } catch {
      row = null;
    }

    const weights: Record<ComponentKey, number> = { ...DEFAULT_WEIGHTS };
    if (row) {
      const map: Record<ComponentKey, any> = {
        punctuality: row.weightPunctuality,
        uniform: row.weightUniform,
        inventory: row.weightInventory,
        consignas: row.weightConsignas,
        rondas: row.weightRondas,
        quiz: row.weightQuiz,
        training: row.weightTraining,
      };
      (Object.keys(map) as ComponentKey[]).forEach((k) => {
        if (map[k] != null && Number.isFinite(Number(map[k]))) {
          weights[k] = Number(map[k]);
        }
      });
    }

    return {
      weights,
      graceMin: num(row?.graceMinutes, ENV.graceMin),
      lateFloorMin: num(row?.lateFloorMinutes, ENV.lateFloorMin),
      expectedPatrols: num(row?.expectedPatrolsPerShift, ENV.expectedPatrols),
      penaltyK: num(row?.penaltyK, ENV.penaltyK),
      penaltyA: num(row?.penaltyA, ENV.penaltyA),
      penaltyB: num(row?.penaltyB, ENV.penaltyB),
      penaltyC: num(row?.penaltyC, ENV.penaltyC),
      volPts: num(row?.volunteerPoints, ENV.volPts),
      coverPts: num(row?.coverPoints, ENV.coverPts),
      bonusCap: num(row?.bonusCap, ENV.bonusCap),
    };
  }

  private async compute({
    subjectUserId,
    securityGuard,
    subjectType,
    periodDays,
  }: {
    subjectUserId?: string;
    securityGuard: any;
    subjectType: SubjectType;
    periodDays: number;
  }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const now = new Date();
    const from = new Date(now.getTime() - periodDays * DAY_MS);
    const knobs = await this.loadKnobs();
    const sgId = securityGuard?.id;

    // ---------------------------------------------------------------
    // Worked shifts (clock-in records) + scheduled shifts in the period.
    // ---------------------------------------------------------------
    const worked: any[] = sgId
      ? (
          await db.guardShift.findAll({
            where: {
              guardNameId: sgId,
              tenantId,
              punchInTime: { [Op.gte]: from, [Op.lte]: now },
            },
            order: [['punchInTime', 'ASC']],
          })
        ).map((r: any) => r.get({ plain: true }))
      : [];

    const scheduled: any[] = subjectUserId
      ? (
          await db.shift.findAll({
            where: {
              guardId: subjectUserId,
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
    const workedShiftIds = worked.map((w) => w.id);

    // --- pair each worked shift with the closest scheduled shift ---
    const latenesses: number[] = [];
    const matchedScheduledIds = new Set<string>();
    let onTimeShifts = 0;
    let tardies = 0;
    let hoursWorked = 0;

    for (const w of worked) {
      const punchIn = new Date(w.punchInTime).getTime();
      if (w.punchOutTime) hoursWorked += hours(w.punchInTime, w.punchOutTime);

      let best: any = null;
      let bestDelta = Infinity;
      for (const sched of scheduled) {
        const delta = Math.abs(new Date(sched.startTime).getTime() - punchIn);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = sched;
        }
      }
      const matched = best && bestDelta <= MATCH_WINDOW_MS ? best : null;
      if (matched) {
        matchedScheduledIds.add(matched.id);
        const lateMin =
          (punchIn - new Date(matched.startTime).getTime()) / 60000;
        latenesses.push(lateMin);
        if (lateMin <= knobs.graceMin) onTimeShifts++;
        if (lateMin > knobs.lateFloorMin) tardies++;
      }
    }

    // --- absences: scheduled shifts that already ended with no clock-in,
    //     excluding dates covered by an approved time-off request. ---
    const excused = await this.loadExcusedDates(subjectUserId, from, now);
    let absences = 0;
    for (const sched of scheduled) {
      if (matchedScheduledIds.has(sched.id)) continue;
      const ended =
        new Date(sched.endTime || sched.startTime).getTime() < now.getTime();
      if (!ended) continue; // upcoming shift can't be an absence yet
      const dayKey = new Date(sched.startTime).toISOString().slice(0, 10);
      if (excused.has(dayKey)) continue;
      absences++;
    }

    // --- forced clock-outs: shifts auto-closed at shift end because the guard
    //     never clocked out in the app (light penalty). ---
    const forcedClockOuts = worked.filter((w) => w.forcedClockOut).length;

    // ---------------------------------------------------------------
    // Factor sub-scores (0..1, or null when there's no data to judge).
    // ---------------------------------------------------------------
    const s: Partial<Record<ComponentKey, number>> = {};

    // punctuality
    if (latenesses.length > 0) {
      const per = latenesses.map((late) => {
        if (late <= knobs.graceMin) return 1;
        if (late >= knobs.lateFloorMin) return 0;
        return clamp(
          1 - (late - knobs.graceMin) / (knobs.lateFloorMin - knobs.graceMin),
          0,
          1,
        );
      });
      s.punctuality = mean(per);
    }

    // uniform
    const uniformStat = await this.uniformScore(subjectUserId, from, now);
    if (uniformStat != null) s.uniform = uniformStat;

    // inventory
    const inv = await this.inventoryScore(worked, workedShiftIds);
    if (inv != null) s.inventory = inv;

    // consignas
    const cons = await this.consignasScore(subjectUserId, sgId, from, now);
    if (cons.score != null) s.consignas = cons.score;

    // rondas
    const ron = await this.rondasScore(subjectUserId, worked, from, now, knobs);
    if (ron != null) s.rondas = ron;

    // quiz
    const qz = await this.quizScore(subjectUserId, from, now);
    if (qz != null) s.quiz = qz;

    // training
    const tr = await this.trainingScore(sgId);
    if (tr != null) s.training = tr;

    // ---------------------------------------------------------------
    // Weighted base (renormalize over factors that have data).
    // ---------------------------------------------------------------
    let weightSum = 0;
    let acc = 0;
    const components = (Object.keys(knobs.weights) as ComponentKey[])
      .filter((k) => s[k] != null)
      .map((k) => {
        weightSum += knobs.weights[k];
        acc += (s[k] as number) * knobs.weights[k];
        return {
          key: k,
          score: Math.round((s[k] as number) * 100),
          weight: knobs.weights[k],
        };
      });

    const hasData = components.length > 0;
    const base100 = weightSum > 0 ? (acc / weightSum) * 100 : 0;

    // ---------------------------------------------------------------
    // Backup bonus + logarithmic absence penalty.
    // ---------------------------------------------------------------
    const backup = await this.backupCounts(subjectUserId, from, now);
    const rawBonus =
      backup.volunteerCount * knobs.volPts + backup.coverCount * knobs.coverPts;
    const bonus = hasData ? Math.min(rawBonus, knobs.bonusCap) : 0;

    const penalty = hasData
      ? knobs.penaltyK *
        Math.log(
          1 +
            knobs.penaltyA * absences +
            knobs.penaltyB * tardies +
            knobs.penaltyC * forcedClockOuts,
        )
      : 0;

    const overall = hasData
      ? Math.round(clamp(base100 - penalty + bonus, 1, 100))
      : 0;
    const tier = tierFor(overall);

    // --- actionable tips for the weakest factors ---
    const tips: ComponentKey[] = [];
    (Object.keys(knobs.weights) as ComponentKey[]).forEach((k) => {
      if (s[k] != null && (s[k] as number) < 0.85) tips.push(k);
    });

    const avgLatenessMin = latenesses.length
      ? Math.round(
          (latenesses.reduce((a, b) => a + Math.max(0, b), 0) /
            latenesses.length) *
            10,
        ) / 10
      : 0;

    return {
      generatedAt: now.toISOString(),
      period: {
        days: periodDays,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      subjectType,
      guard: securityGuard
        ? { id: securityGuard.id, fullName: securityGuard.fullName }
        : null,
      score: overall,
      base: Math.round(base100),
      tier,
      hasData,
      components,
      penalty: {
        points: Math.round(penalty * 10) / 10,
        absences,
        tardies,
        forcedClockOuts,
      },
      bonus: {
        points: bonus,
        volunteerCount: backup.volunteerCount,
        coverCount: backup.coverCount,
        cap: knobs.bonusCap,
      },
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
        absences,
        tardies,
        uniformAvg: s.uniform != null ? Math.round(s.uniform * 100) : null,
        inventoryRate:
          s.inventory != null ? Math.round(s.inventory * 100) : null,
        consignasRate:
          s.consignas != null ? Math.round(s.consignas * 100) : null,
        consignasDue: cons.due,
        consignasDone: cons.done,
        rondasRate: s.rondas != null ? Math.round(s.rondas * 100) : null,
        quizAvg: s.quiz != null ? Math.round(s.quiz * 100) : null,
        trainingRate: s.training != null ? Math.round(s.training * 100) : null,
      },
      tips,
    };
  }

  // -----------------------------------------------------------------
  // Per-factor helpers
  // -----------------------------------------------------------------

  /** Set of YYYY-MM-DD dates covered by an approved time-off request. */
  private async loadExcusedDates(
    userId: string | undefined,
    from: Date,
    now: Date,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (!userId) return out;
    try {
      const reqs = await this.db.timeOffRequest.findAll({
        where: {
          guardId: userId,
          tenantId: this.tenantId,
          status: { [Op.in]: ['approved', 'Approved', 'aprobado', 'Aprobado'] },
          deletedAt: null,
        },
        attributes: ['startDate', 'endDate'],
      });
      for (const r of reqs) {
        const sd = r.startDate ? new Date(r.startDate) : null;
        const ed = r.endDate ? new Date(r.endDate) : sd;
        if (!sd) continue;
        for (let t = sd.getTime(); t <= (ed as Date).getTime(); t += DAY_MS) {
          out.add(new Date(t).toISOString().slice(0, 10));
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /** Mean uniform-inspection rating (0..1) in the period, or null. */
  private async uniformScore(
    userId: string | undefined,
    from: Date,
    now: Date,
  ): Promise<number | null> {
    if (!userId || !this.db.uniformInspection) return null;
    try {
      const rows = await this.db.uniformInspection.findAll({
        where: {
          subjectUserId: userId,
          tenantId: this.tenantId,
          inspectionDate: { [Op.gte]: from, [Op.lte]: now },
          deletedAt: null,
        },
        attributes: ['rating'],
      });
      if (!rows.length) return null;
      return clamp(
        mean(rows.map((r: any) => Number(r.rating) || 0)) / 100,
        0,
        1,
      );
    } catch {
      return null;
    }
  }

  /** Complete inventory checks / worked shifts whose station has inventory. */
  private async inventoryScore(
    worked: any[],
    workedShiftIds: string[],
  ): Promise<number | null> {
    if (!worked.length || !this.db.inventoryHistory) return null;
    try {
      const stationIds = Array.from(
        new Set(worked.map((w) => w.stationId).filter(Boolean)),
      );
      if (!stationIds.length) return null;

      // Which of those stations actually require an inventory check?
      let stationsWithInventory = new Set<string>(stationIds.map(String));
      if (this.db.inventory) {
        const invs = await this.db.inventory.findAll({
          where: { tenantId: this.tenantId, deletedAt: null },
        });
        const withInv = new Set<string>();
        for (const i of invs) {
          const sid = i.belongsToStation || i.stationId;
          if (sid) withInv.add(String(sid));
        }
        if (withInv.size) {
          stationsWithInventory = new Set(
            stationIds.map(String).filter((sid) => withInv.has(sid)),
          );
        }
      }

      const expected = worked.filter((w) =>
        stationsWithInventory.has(String(w.stationId)),
      ).length;
      if (!expected) return null;

      const complete = await this.db.inventoryHistory.count({
        where: {
          tenantId: this.tenantId,
          guardShiftId: { [Op.in]: workedShiftIds },
          isComplete: true,
          deletedAt: null,
        },
      });
      return clamp(complete / expected, 0, 1);
    } catch {
      return null;
    }
  }

  /** Consignas completed vs due over the period for the guard's stations. */
  private async consignasScore(
    userId: string | undefined,
    sgId: string | undefined,
    from: Date,
    now: Date,
  ): Promise<{ score: number | null; due: number; done: number }> {
    if (!userId || !sgId) return { score: null, due: 0, done: 0 };
    try {
      const db = this.db;
      const stations = await db.station.findAll({
        where: { tenantId: this.tenantId, deletedAt: null },
        attributes: ['id'],
        include: [
          {
            model: db.user,
            as: 'assignedGuards',
            where: { id: userId },
            attributes: [],
            through: { attributes: [] },
            required: true,
          },
        ],
      });
      const stationIds = stations.map((st: any) => st.id);
      if (!stationIds.length) return { score: null, due: 0, done: 0 };

      const tenant = await db.tenant.findByPk(this.tenantId, {
        attributes: ['timezone'],
      });
      const tz = tenant?.timezone || 'UTC';

      const orders = (
        await db.stationOrder.findAll({
          where: {
            tenantId: this.tenantId,
            stationId: { [Op.in]: stationIds },
            active: true,
            deletedAt: null,
          },
        })
      ).map((o: any) => o.get({ plain: true }));
      if (!orders.length) return { score: null, due: 0, done: 0 };

      // Count due occurrences day by day across the period.
      let due = 0;
      const start = new Date(from);
      start.setHours(0, 0, 0, 0);
      for (let t = start.getTime(); t <= now.getTime(); t += DAY_MS) {
        const day = new Date(t);
        for (const o of orders) {
          if (isDueOn(o, day, tz)) due++;
        }
      }
      if (!due) return { score: null, due: 0, done: 0 };

      const done = await db.stationOrderCompletion.count({
        where: {
          tenantId: this.tenantId,
          securityGuardId: sgId,
          occurrenceDate: {
            [Op.gte]: from.toISOString().slice(0, 10),
            [Op.lte]: now.toISOString().slice(0, 10),
          },
          deletedAt: null,
        },
      });
      return { score: clamp(done / due, 0, 1), due, done: Math.min(done, due) };
    } catch {
      return { score: null, due: 0, done: 0 };
    }
  }

  /** Patrols completed vs scheduled (or vs expected per worked shift). */
  private async rondasScore(
    userId: string | undefined,
    worked: any[],
    from: Date,
    now: Date,
    knobs: Knobs,
  ): Promise<number | null> {
    try {
      if (userId && this.db.patrol) {
        const patrols = await this.db.patrol.findAll({
          where: {
            assignedGuardId: userId,
            tenantId: this.tenantId,
            scheduledTime: { [Op.gte]: from, [Op.lte]: now },
            deletedAt: null,
          },
          attributes: ['completed', 'status'],
        });
        if (patrols.length) {
          const done = patrols.filter(
            (p: any) =>
              p.completed === true || /complet/i.test(String(p.status || '')),
          ).length;
          return clamp(done / patrols.length, 0, 1);
        }
      }
      // Fallback: self-reported patrols on worked shifts vs expected.
      if (worked.length) {
        const performed = worked.reduce(
          (sum, w) => sum + (Number(w.numberOfPatrolsDuringShift) || 0),
          0,
        );
        const expected = worked.length * knobs.expectedPatrols;
        if (expected > 0) return clamp(performed / expected, 0, 1);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Best quiz attempt (0..1) in the period, or null. */
  private async quizScore(
    userId: string | undefined,
    from: Date,
    now: Date,
  ): Promise<number | null> {
    if (!userId || !this.db.quizAttempt) return null;
    try {
      const rows = await this.db.quizAttempt.findAll({
        where: {
          subjectUserId: userId,
          tenantId: this.tenantId,
          completedAt: { [Op.gte]: from, [Op.lte]: now },
          deletedAt: null,
        },
        attributes: ['scorePct'],
      });
      if (!rows.length) return null;
      const best = Math.max(...rows.map((r: any) => Number(r.scorePct) || 0));
      return clamp(best / 100, 0, 1);
    } catch {
      return null;
    }
  }

  /** Tutorials completed vs assigned (0..1), or null. */
  private async trainingScore(
    sgId: string | undefined,
  ): Promise<number | null> {
    if (!sgId || !this.db.tutorial || !this.db.completionOfTutorial) {
      return null;
    }
    try {
      const assigned = await this.db.tutorial.count({
        where: { tenantId: this.tenantId, deletedAt: null },
      });
      if (!assigned) return null;

      const completions = await this.db.completionOfTutorial.findAll({
        where: {
          guardNameId: sgId,
          tenantId: this.tenantId,
          wasCompleted: true,
          deletedAt: null,
        },
        attributes: ['tutorialId'],
      });
      const doneTutorials = new Set(
        completions.map((c: any) => String(c.tutorialId)),
      );
      return clamp(doneTutorials.size / assigned, 0, 1);
    } catch {
      return null;
    }
  }

  /** Backup volunteer + confirmed-cover counts in the period. */
  private async backupCounts(
    userId: string | undefined,
    from: Date,
    now: Date,
  ): Promise<{ volunteerCount: number; coverCount: number }> {
    if (!userId || !this.db.backupEvent) {
      return { volunteerCount: 0, coverCount: 0 };
    }
    try {
      const fromDay = from.toISOString().slice(0, 10);
      const toDay = now.toISOString().slice(0, 10);
      const volunteerCount = await this.db.backupEvent.count({
        where: {
          subjectUserId: userId,
          tenantId: this.tenantId,
          kind: 'volunteer',
          status: { [Op.notIn]: ['rejected', 'cancelled'] },
          eventDate: { [Op.gte]: fromDay, [Op.lte]: toDay },
          deletedAt: null,
        },
      });
      const coverCount = await this.db.backupEvent.count({
        where: {
          subjectUserId: userId,
          tenantId: this.tenantId,
          kind: 'cover',
          status: 'confirmed',
          eventDate: { [Op.gte]: fromDay, [Op.lte]: toDay },
          deletedAt: null,
        },
      });
      return { volunteerCount, coverCount };
    } catch {
      return { volunteerCount: 0, coverCount: 0 };
    }
  }
}
