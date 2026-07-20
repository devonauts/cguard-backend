// Reusable station auto-configuration service.
//
// Extracted VERBATIM from the `stationAutoPositions` Express handler in
// src/api/scheduling/schedulingEndpoints.ts so the same position-creation +
// schedule-generation logic can be reused by the bulk `schedulerAutoAssign`
// bootstrap (which needs to create positions for unconfigured stations).
//
// Performance note (optimizeSacafrancos):
//   `optimizeSacafrancos` is a TENANT-WIDE pass. Calling it once per station
//   (e.g. 21+ times during a bulk bootstrap) would be O(n) redundant tenant-wide
//   passes. To avoid that O(n^2) blowup, this helper accepts a
//   `runSacafrancoOptimize` flag (default true). The single-station Express
//   handler keeps the default (true) so its behaviour is unchanged. The bulk
//   `schedulerAutoAssign` bootstrap passes `false` per-station (so each station
//   only does positions + generateYearlyScheduleForStation) and then calls
//   `optimizeSacafrancos` + the SF-guard assignment ONCE itself after all empty
//   stations are configured.

/**
 * Derive the coverage type from a station's window when the caller didn't state
 * one. Mirrors the frontend AddStationPage.jornadaType/turnoToScheduleType so
 * the API and the two creation UIs agree. A full-day / empty window ⇒ '24h';
 * a night window (ends at/before it starts, or starts ≥18h or <5h) ⇒ '12h-night';
 * anything else ⇒ '12h-day'. Callers who mean 'custom' pass it explicitly.
 */
export function deriveScheduleType(start?: string | null, end?: string | null): string {
  const hour = (s?: string | null) => {
    if (!s) return null;
    const m = String(s).match(/(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) : null;
  };
  const sh = hour(start);
  const eh = hour(end);
  // No window, or a literal all-day span → a 24h post (two 12h jornadas).
  if (sh == null) return '24h';
  if ((sh === 0 && eh === 0) || (start === end)) return '24h';
  if (eh != null && eh <= sh) return '12h-night';
  if (sh >= 18 || sh < 5) return '12h-night';
  return '12h-day';
}

/** Find a system rotation style by name, creating it if missing. Returns its id. */
export async function ensureRotationStyle(db: any, name: string, dayShifts: number, nightShifts: number, restDays: number): Promise<string | null> {
  const existing = await db.rotationStyle.findOne({ where: { name, isSystem: true } });
  if (existing) return existing.id;
  const created = await db.rotationStyle.create({
    name,
    description: `${dayShifts} trabajo${nightShifts ? `, ${nightShifts} noche` : ''}, ${restDays} descanso`,
    dayShifts, nightShifts, restDays,
    isSystem: true, tenantId: null,
  });
  return created.id;
}

export async function autoConfigureStationPositions(
  db: any,
  params: {
    stationId: string;
    tenantId: string;
    userId: string;
    scheduleType?: string;
    rotationStyleId?: string | null;
    data?: any;
    runSacafrancoOptimize?: boolean;
  },
): Promise<{
  rows: any[];
  count: number;
  rotationStyleId: string | null;
  recommendedPlatoonOffset: number;
  sfAvailableAtExecution: number;
  sfAssignedNow: number;
  sfOpenRemaining: number;
}> {
  const { Op } = db.Sequelize;
  const { stationId, tenantId, userId } = params;
  const data = params.data || {};
  let rotationStyleId = params.rotationStyleId || data.rotationStyleId || null;
  const runSacafrancoOptimize = params.runSacafrancoOptimize !== false;

  // Auto-pick recommended rotation if not specified. ALL stations use a 10-day
  // cycle so they SYNC with each other and the sacafranco (also 10-day): a 24h
  // station rotates 4-4-2 (its 2 fijos swap day/night); a 12h station uses 8-2
  // (8 work, 2 rest, single shift). Same cycle length ⇒ each guard rests 2 days
  // per cycle and ONE sacafranco can chain through all of their rest days.
  // Custom rest-coverage mode: 'sacafranco' (default — one fijo per block,
  // staggered rests, SF covers the gaps) or 'alternate' (N fijos share each
  // block phased by workDays so exactly one works every day — e.g. the classic
  // 24x24: trabaja 1 / descansa 1, 2 fijos, NO sacafranco).
  const restCoverage = String(data.restCoverage || 'sacafranco');

  // scheduleType: honour an explicit value, else DERIVE it from the station's
  // configured window instead of blindly stamping '24h'. Forcing '24h' left a
  // 07:00–19:00 puesto mislabeled as "24 Horas / 00:00–23:59" in every list
  // (Cliente › Cobertura, Programador) even though the four coverage types
  // (12h-day | 12h-night | 24h | custom) are all valid. Mirrors the frontend
  // AddStationPage.jornadaType/turnoToScheduleType mapping.
  let scheduleType: string = params.scheduleType || data.scheduleType || '';
  if (!scheduleType) {
    const st = await db.station.findOne({
      where: { id: stationId, tenantId },
      attributes: ['startingTimeInDay', 'finishTimeInDay'],
    });
    scheduleType = deriveScheduleType(st?.startingTimeInDay, st?.finishTimeInDay);
  }

  if (!rotationStyleId) {
    if (scheduleType === '24h') {
      const r = await db.rotationStyle.findOne({ where: { name: '4-4-2', isSystem: true } });
      rotationStyleId = r?.id || null;
    } else if (scheduleType === 'custom' && restCoverage === 'alternate') {
      // Natural default for alternation: work 1 / rest 1 (24x24).
      rotationStyleId = await ensureRotationStyle(db, '1-1', 1, 0, 1);
    } else {
      rotationStyleId = await ensureRotationStyle(db, '8-2', 8, 0, 2);
    }
  }

  // Update station scheduleType and rotationStyleId
  const stationUpdate: any = { scheduleType };
  if (rotationStyleId) stationUpdate.rotationStyleId = rotationStyleId;
  await db.station.update(stationUpdate, { where: { id: stationId, tenantId } });

  // Delete assignments and shifts referencing existing positions, then delete positions
  const existingPositions = await db.stationPosition.findAll({ where: { stationId, tenantId }, attributes: ['id'] });
  const positionIds = existingPositions.map((p: any) => p.id);
  if (positionIds.length > 0) {
    await db.shift.destroy({ where: { positionId: positionIds, tenantId }, force: true });
    await db.guardAssignment.destroy({ where: { positionId: positionIds, tenantId }, force: true });
    await db.stationPosition.destroy({ where: { id: positionIds, tenantId }, force: true });
  }

  const positions: any[] = [];
  const now = new Date();

  // Calculate recommended sequential station offset (same algorithm as sacafranco optimizer)
  // so newly added stations immediately follow global sequence.
  let cycleLength = 7;
  let workDays = 5;
  let restDays = 2;
  let dayShifts = 5;
  if (rotationStyleId) {
    const rot = await db.rotationStyle.findByPk(rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
    if (rot) {
      dayShifts = rot.dayShifts || 0;
      workDays = (rot.dayShifts || 0) + (rot.nightShifts || 0);
      restDays = rot.restDays || 1;
      cycleLength = workDays + restDays;
    }
  }

  // Build ordered station group with same cycle and compute this station index in sequence.
  let recommendedStationOffset = 0;
  if (cycleLength > 0) {
    const allStations = await db.station.findAll({
      where: { tenantId, deletedAt: null, rotationStyleId: { [Op.ne]: null } },
      attributes: ['id', 'stationName', 'rotationStyleId'],
      order: [['stationName', 'ASC']],
    });

    const rotationCache = new Map<string, any>();
    for (const st of allStations) {
      if (!rotationCache.has(st.rotationStyleId)) {
        const r = await db.rotationStyle.findByPk(st.rotationStyleId, { attributes: ['dayShifts', 'nightShifts', 'restDays'] });
        if (r) rotationCache.set(st.rotationStyleId, r);
      }
    }

    const sameCycleStations = allStations.filter((st: any) => {
      const r = rotationCache.get(st.rotationStyleId);
      if (!r) return false;
      const c = (r.dayShifts || 0) + (r.nightShifts || 0) + (r.restDays || 0);
      return c === cycleLength;
    });

    const currentIndex = sameCycleStations.findIndex((st: any) => st.id === stationId);
    const stationIndex = currentIndex >= 0 ? currentIndex : sameCycleStations.length;
    recommendedStationOffset = (stationIndex * restDays - workDays + cycleLength * 10) % cycleLength;
  }

  // ALTERNATION (custom, no sacafranco): anchor the phase to TODAY so the FIRST
  // fijo works TODAY (and its alternating partner tomorrow). Without this the
  // fijos inherit an epoch-anchored offset with arbitrary calendar parity, so a
  // guard assigned "para empezar hoy" could land on tomorrow — the operator has
  // no way to pick which position works which day. There's no sacafranco here,
  // so the cross-station sequencing offset above is irrelevant; today-anchoring
  // is strictly more intuitive. (Sacafranco mode keeps the sequencing offset so
  // rest days still chain for the SF.)
  if (scheduleType === 'custom' && restCoverage === 'alternate' && cycleLength > 0) {
    const { ymd } = require('./consignaRecurrence');
    const tenantRow = await db.tenant.findByPk(tenantId, { attributes: ['timezone'] });
    const tz = (tenantRow && tenantRow.timezone) || 'UTC';
    const todayStr = ymd(new Date(), tz);
    // Same epoch + day-index math the shift generator uses (ROTATION_EPOCH
    // 2024-01-01), so "work day 0 = today" holds at generation time.
    const epochMs = Date.UTC(2024, 0, 1);
    const dseToday = Math.floor((Date.parse(`${todayStr}T00:00:00Z`) - epochMs) / 86400000);
    recommendedStationOffset = ((dseToday % cycleLength) + cycleLength) % cycleLength;
  }

  if (scheduleType === '24h') {
    // 24h station needs continuous day+night coverage. Phase out the two fijos
    // by `dayShifts` so when Fijo 1 is on its DAY block, Fijo 2 is on its NIGHT
    // block (and vice-versa) — instead of the old bug where both shared an
    // offset and worked/rested identically (days double-staffed, nights empty,
    // 2-day blackout). Residual gaps are covered by sacafrancos.
    const offset2 = ((recommendedStationOffset - dayShifts) % cycleLength + cycleLength) % cycleLength;
    positions.push(
      { name: 'Fijo 1', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 0, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
      { name: 'Fijo 2', type: 'fijo', startTime: '07:00', endTime: '19:00', guardsNeeded: 1, sortOrder: 1, platoonOffset: offset2, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
    );
  } else if (scheduleType === '12h-day' || scheduleType === '12h-night') {
    const start = scheduleType === '12h-day' ? '07:00' : '19:00';
    const end = scheduleType === '12h-day' ? '19:00' : '07:00';
    positions.push(
      { name: 'Fijo 1', type: 'fijo', startTime: start, endTime: end, guardsNeeded: 1, sortOrder: 0, platoonOffset: recommendedStationOffset, stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now },
    );
  } else {
    // Custom: the tenant picks the station's operating window (any hours, may
    // wrap midnight) and optionally the per-guard shift length (`blockHours`).
    // The window is split into K consecutive blocks → K fijo positions, each
    // carrying ITS OWN startTime/endTime (the shift generator already emits
    // hours from the position row, so multi-block works without touching it).
    // Offsets are staggered exactly like the 24h pair (base − i·dayShifts) so
    // the fijos' rest blocks never overlap and one sacafranco can chain them.
    const customStart = data.startTime || '07:00';
    const customEnd = data.endTime || '19:00';
    const toMin = (hhmm: string) => {
      const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10) || 0);
      return ((h % 24) * 60 + (m % 60) + 1440) % 1440;
    };
    const toHHMM = (min: number) => {
      const mm = ((min % 1440) + 1440) % 1440;
      return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
    };
    const startMin = toMin(customStart);
    let windowMin = (toMin(customEnd) - startMin + 1440) % 1440;
    if (windowMin === 0) windowMin = 1440; // full-day custom window
    const blockHours = Number(data.blockHours) || 0;
    let blockCount = 1;
    if (blockHours > 0) {
      const blockMin = Math.round(blockHours * 60);
      if (blockMin < 60 || windowMin % blockMin !== 0) {
        throw new Error(
          `La duración del turno (${blockHours}h) debe dividir exactamente la cobertura de la estación (${windowMin / 60}h).`,
        );
      }
      blockCount = windowMin / blockMin;
    }
    const blockMin = windowMin / blockCount;

    // Alternation: N fijos per block, phased by workDays so their work blocks
    // tile the cycle (exactly one on duty per day, rest covered by the partner
    // — no sacafranco). Requires the cycle to divide evenly by the work days.
    let guardsPerBlock = 1;
    if (restCoverage === 'alternate') {
      const workDaysN = Math.max(1, dayShifts);
      if (cycleLength % workDaysN !== 0) {
        throw new Error(
          `El patrón (${workDaysN} trabajo / ${cycleLength - workDaysN} descanso) no permite alternancia exacta: el ciclo debe ser múltiplo de los días de trabajo.`,
        );
      }
      guardsPerBlock = cycleLength / workDaysN;
    }

    for (let b = 0; b < blockCount; b++) {
      for (let a = 0; a < guardsPerBlock; a++) {
        const idx = b * guardsPerBlock + a;
        // One formula for both modes: blocks stagger by dayShifts (spreads rest
        // days for the SF), and alternators within a block ALSO phase by
        // dayShifts (= the rotation's work days, custom styles have no night
        // shifts) so their work windows tile the cycle exactly.
        const offsetI =
          (((recommendedStationOffset - (b + a) * dayShifts) % cycleLength) + cycleLength) % cycleLength;
        positions.push({
          name: blockCount * guardsPerBlock > 1 ? `Fijo ${idx + 1}` : 'Fijo 1',
          type: 'fijo',
          startTime: toHHMM(startMin + b * blockMin),
          endTime: toHHMM(startMin + (b + 1) * blockMin),
          guardsNeeded: 1,
          sortOrder: idx,
          platoonOffset: offsetI,
          stationId, tenantId, createdById: userId, updatedById: userId, createdAt: now, updatedAt: now,
        });
      }
    }
    // Keep the station row's window + fijo count in sync so lists/reports and
    // the post-site coverage endpoint see the real custom configuration.
    await db.station.update(
      {
        startingTimeInDay: toHHMM(startMin),
        finishTimeInDay: toHHMM(startMin + windowMin),
        numberOfGuardsInStation: String(blockCount * guardsPerBlock),
      },
      { where: { id: stationId, tenantId } },
    );
  }

  await db.stationPosition.bulkCreate(positions);
  const created = await db.stationPosition.findAll({
    where: { stationId, tenantId, deletedAt: null },
    order: [['sortOrder', 'ASC']],
  });

  let sfAvailableAtExecution = 0;
  let sfAssignedNow = 0;
  let sfOpenRemaining = 0;

  try {
    const { generateYearlyScheduleForStation } = await import('./shiftGenerationService');
    await generateYearlyScheduleForStation(db, stationId, tenantId, userId);

    if (runSacafrancoOptimize) {
      // Auto-optimize: ensures sequence across ALL stations. Skipped when the
      // caller (bulk bootstrap) runs this tenant-wide pass once itself.
      const result = await optimizeAndAssignSacafrancos(db, tenantId, userId);
      sfAvailableAtExecution = result.sfAvailableAtExecution;
      sfAssignedNow = result.sfAssignedNow;
      sfOpenRemaining = result.sfOpenRemaining;
    }
  } catch (e) {
    console.error('[autoConfigureStationPositions] Yearly generation / sacafranco optimization error:', e);
  }

  return {
    rows: created,
    count: created.length,
    rotationStyleId,
    recommendedPlatoonOffset: recommendedStationOffset,
    sfAvailableAtExecution,
    sfAssignedNow,
    sfOpenRemaining,
  };
}

// Runs the tenant-wide sacafranco optimization, then assigns available SF guards
// to unfilled sacafranco positions (generating their shifts). Extracted VERBATIM
// from the second half of the original stationAutoPositions try-block so it can be
// invoked exactly once per bulk run instead of once per station.
export async function optimizeAndAssignSacafrancos(
  db: any,
  tenantId: string,
  userId: string,
): Promise<{ sfAvailableAtExecution: number; sfAssignedNow: number; sfOpenRemaining: number }> {
  let sfAvailableAtExecution = 0;
  let sfAssignedNow = 0;
  let sfOpenRemaining = 0;

  const { optimizeSacafrancos, generateShiftsForAssignment } = await import('./shiftGenerationService');
  await optimizeSacafrancos(db, tenantId, userId);

  // Auto-assign available SF guards to unfilled sacafranco positions (if any)
  const [sfPositions, activeAssignments, sfGuards, stationMap] = await Promise.all([
    db.stationPosition.findAll({ where: { tenantId, deletedAt: null, type: 'sacafranco' } }),
    db.guardAssignment.findAll({ where: { tenantId, status: 'active', deletedAt: null }, attributes: ['guardId', 'positionId'] }),
    db.securityGuard.findAll({ where: { tenantId, deletedAt: null }, attributes: ['guardId', 'guardType'] }),
    db.station.findAll({ where: { tenantId, deletedAt: null }, attributes: ['id', 'rotationStyleId'] }),
  ]);

  const assignedGuardIds = new Set(activeAssignments.map((a: any) => a.guardId));
  const assignedSfPositionIds = new Set(activeAssignments.map((a: any) => a.positionId));
  const availableSfGuards = sfGuards.filter((g: any) =>
    g.guardId &&
    !assignedGuardIds.has(g.guardId) &&
    String(g.guardType || '').toLowerCase() === 'sacafranco'
  );

  const openSfPositions = sfPositions.filter((p: any) => !assignedSfPositionIds.has(p.id));
  sfAvailableAtExecution = availableSfGuards.length;

  if (availableSfGuards.length > 0 && openSfPositions.length > 0) {
    const byStation = new Map<string, any>();
    stationMap.forEach((s: any) => byStation.set(s.id, s));
    const sfRot = await db.rotationStyle.findOne({ where: { name: '6-1', isSystem: true } });
    const startDate = new Date().toISOString().slice(0, 10);

    const createCount = Math.min(availableSfGuards.length, openSfPositions.length);
    for (let i = 0; i < createCount; i++) {
      const guard = availableSfGuards[i];
      const pos = openSfPositions[i];
      const station = byStation.get(pos.stationId);
      const assignment = await db.guardAssignment.create({
        guardId: guard.guardId,
        stationId: pos.stationId,
        positionId: pos.id,
        rotationStyleId: sfRot?.id || station?.rotationStyleId,
        startDate,
        endDate: null,
        platoonOffset: pos.platoonOffset || 0,
        isRelief: true,
        status: 'active',
        tenantId,
        createdById: userId,
        updatedById: userId,
      });

      await generateShiftsForAssignment(db, assignment.get({ plain: true }), tenantId, userId);
      sfAssignedNow++;
    }
  }

  sfOpenRemaining = Math.max(0, openSfPositions.length - sfAssignedNow);
  return { sfAvailableAtExecution, sfAssignedNow, sfOpenRemaining };
}
