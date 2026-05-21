import SequelizeRepository from '../database/repositories/sequelizeRepository';
import Error400 from '../errors/Error400';
import { getConfig } from '../config';
import { Op } from 'sequelize';

/**
 * SchedulerService
 * 
 * Uses OpenAI to generate optimal shift schedules based on:
 * - Station requirements (stationSchedule JSON)
 * - Available guards (titular + sacafranco pool)
 * - Work rules (max days, rest days, overtime thresholds)
 * - Existing time-off requests
 * - Cost optimization
 */
export default class SchedulerService {

  /**
   * Generate an AI-optimized schedule proposal
   */
  static async generateSchedule(body, req) {
    const { stationId, startDate, endDate } = body;

    if (!stationId || !startDate || !endDate) {
      throw new Error400(req.language, 'scheduler.missingFields');
    }

    const database = req.database;
    const tenantId = req.currentTenant?.id;

    // 1. Get station details and requirements
    const station = await database.station.findByPk(stationId, {
      where: { tenantId },
    });

    if (!station) {
      throw new Error400(req.language, 'scheduler.stationNotFound');
    }

    const stationPlain = station.get({ plain: true });

    // Parse station schedule requirements
    let scheduleRequirements: any[] = [];
    try {
      scheduleRequirements = typeof stationPlain.stationSchedule === 'string'
        ? JSON.parse(stationPlain.stationSchedule)
        : (stationPlain.stationSchedule || []);
    } catch (e) {
      scheduleRequirements = [];
    }

    // 2. Get assigned guards (titulares) for this station
    const assignedGuardIds = await database.sequelize.query(
      `SELECT userId FROM stationAssignedGuardsUser WHERE stationId = :stationId`,
      { replacements: { stationId }, type: database.sequelize.QueryTypes.SELECT }
    );
    const guardUserIds = assignedGuardIds.map((r: any) => r.userId);

    // 3. Get all available guards (titulares + sacafrancos) in this tenant
    const guards = await database.securityGuard.findAll({
      where: {
        tenantId,
        deletedAt: null,
        guardId: { [Op.ne]: null },
      },
      attributes: ['id', 'fullName', 'guardId', 'guardType', 'workRules', 'availability', 'skills'],
    });

    const titulares = guards.filter((g: any) => guardUserIds.includes(g.guardId));
    const sacafrancos = guards.filter((g: any) => g.guardType === 'sacafranco');
    const allAvailable = guards.map((g: any) => g.get({ plain: true }));

    // 4. Get existing time-off requests in the date range
    const timeOffRequests = await database.timeOffRequest.findAll({
      where: {
        tenantId,
        status: 'approved',
        deletedAt: null,
        [Op.or]: [
          { startDate: { [Op.between]: [startDate, endDate] } },
          { endDate: { [Op.between]: [startDate, endDate] } },
        ],
      },
      attributes: ['guardId', 'startDate', 'endDate', 'type'],
    });

    // 5. Get existing shifts in the date range to avoid conflicts
    const existingShifts = await database.shift.findAll({
      where: {
        tenantId,
        deletedAt: null,
        stationId,
        [Op.or]: [
          { startTime: { [Op.between]: [startDate, endDate] } },
          { endTime: { [Op.between]: [startDate, endDate] } },
        ],
      },
      attributes: ['id', 'guardId', 'startTime', 'endTime'],
    });

    // 6. Build context for AI
    const context = {
      station: {
        id: stationPlain.id,
        name: stationPlain.stationName,
        scheduleRequirements,
        startingTimeInDay: stationPlain.startingTimeInDay,
        finishTimeInDay: stationPlain.finishTimeInDay,
        numberOfGuardsNeeded: stationPlain.numberOfGuardsInStation,
      },
      dateRange: { startDate, endDate },
      titulares: titulares.map((g: any) => ({
        id: g.guardId,
        sgId: g.id,
        name: g.fullName,
        guardType: g.guardType,
        workRules: g.workRules || getDefaultWorkRules(),
        availability: g.availability,
      })),
      sacafrancos: sacafrancos.map((g: any) => ({
        id: g.guardId,
        sgId: g.id,
        name: g.fullName,
        guardType: 'sacafranco',
        workRules: g.workRules || getDefaultWorkRules(),
        availability: g.availability,
      })),
      timeOff: timeOffRequests.map((t: any) => t.get({ plain: true })),
      existingShifts: existingShifts.map((s: any) => s.get({ plain: true })),
    };

    // 7. Call OpenAI for schedule generation
    const schedule = await callOpenAIScheduler(context);

    return {
      station: { id: stationPlain.id, name: stationPlain.stationName },
      dateRange: { startDate, endDate },
      scheduleRequirements,
      proposedShifts: schedule.proposedShifts,
      sacafrancoAssignments: schedule.sacafrancoAssignments,
      summary: schedule.summary,
      estimatedCost: schedule.estimatedCost,
      warnings: schedule.warnings,
    };
  }

  /**
   * Apply a generated schedule — create actual shift records
   */
  static async applySchedule(body, req) {
    const { proposedShifts, stationId } = body;

    if (!proposedShifts || !Array.isArray(proposedShifts) || !stationId) {
      throw new Error400(req.language, 'scheduler.missingFields');
    }

    const database = req.database;
    const tenantId = req.currentTenant?.id;
    const currentUser = req.currentUser;

    const station = await database.station.findByPk(stationId, {
      where: { tenantId },
    });

    if (!station) {
      throw new Error400(req.language, 'scheduler.stationNotFound');
    }

    const transaction = await database.sequelize.transaction();
    const createdShifts: any[] = [];

    try {
      for (const shift of proposedShifts) {
        const record = await database.shift.create(
          {
            startTime: shift.startTime,
            endTime: shift.endTime,
            guardId: shift.guardId,
            stationId: stationId,
            postSiteId: station.postSiteId,
            tenantId,
            createdById: currentUser.id,
            updatedById: currentUser.id,
          },
          { transaction },
        );

        // Also update the station's assignedGuards junction
        if (shift.guardId) {
          await station.addAssignedGuards(shift.guardId, { transaction });
        }

        createdShifts.push(record.get({ plain: true }));
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    return {
      created: createdShifts.length,
      shifts: createdShifts,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getDefaultWorkRules() {
  return {
    maxConsecutiveDays: 5,
    restDaysPerWeek: 2,
    maxHoursPerDay: 12,
    overtimeThresholdHours: 8,
    preferredRestDays: [], // e.g. ["saturday", "sunday"]
  };
}

async function callOpenAIScheduler(context: any) {
  const apiKey = getConfig().OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    // Fallback: generate a basic schedule without AI
    return generateBasicSchedule(context);
  }

  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey });

  const systemPrompt = `You are a security guard scheduling optimizer. Given station requirements, available guards (titulares and sacafrancos), time-off requests, and work rules, generate an optimal shift schedule.

Rules:
- Each guard must have the required rest days per their workRules (default 2 per week)
- When a titular guard has a rest day, assign a sacafranco (backup guard) to cover
- Minimize overtime (shifts over overtimeThresholdHours cost 1.5x)
- Respect approved time-off requests
- Each shift must have the required number of guards per the station's scheduleRequirements
- Prefer assigning titulares to their station; use sacafrancos only for coverage gaps

Respond ONLY with valid JSON in this exact format:
{
  "proposedShifts": [
    { "guardId": "uuid", "guardName": "Name", "startTime": "ISO datetime", "endTime": "ISO datetime", "type": "titular|sacafranco" }
  ],
  "sacafrancoAssignments": [
    { "date": "YYYY-MM-DD", "sacafrancoId": "uuid", "sacafrancoName": "Name", "coversFor": "titular name", "reason": "rest day|time off" }
  ],
  "summary": { "totalShifts": N, "titularShifts": N, "sacafrancoShifts": N, "totalHours": N, "overtimeHours": N },
  "estimatedCost": { "regularHours": N, "overtimeHours": N, "totalRelativeCost": N },
  "warnings": ["any issues or conflicts"]
}`;

  const userPrompt = `Generate a schedule for:

Station: ${context.station.name}
Date Range: ${context.dateRange.startDate} to ${context.dateRange.endDate}
Schedule Requirements: ${JSON.stringify(context.station.scheduleRequirements)}
Station Hours: ${context.station.startingTimeInDay} - ${context.station.finishTimeInDay}

Titular Guards (assigned to this station):
${JSON.stringify(context.titulares, null, 2)}

Sacafranco Guards (backup pool):
${JSON.stringify(context.sacafrancos, null, 2)}

Approved Time-Off:
${JSON.stringify(context.timeOff, null, 2)}

Existing Shifts (avoid conflicts):
${JSON.stringify(context.existingShifts, null, 2)}

Generate the optimal schedule.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return generateBasicSchedule(context);
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('[Scheduler] OpenAI error, falling back to basic:', error.message);
    return generateBasicSchedule(context);
  }
}

/**
 * Fallback basic schedule generator (no AI)
 * Creates a simple rotation based on available guards and requirements
 */
function generateBasicSchedule(context: any) {
  const { station, dateRange, titulares, sacafrancos } = context;
  const proposedShifts: any[] = [];
  const sacafrancoAssignments: any[] = [];
  const warnings: string[] = [];

  const start = new Date(dateRange.startDate);
  const end = new Date(dateRange.endDate);

  // Determine shift times from station requirements
  const requirements = station.scheduleRequirements || [];
  const defaultShift = {
    startTime: station.startingTimeInDay || '07:00',
    endTime: station.finishTimeInDay || '19:00',
    guardsCount: 1,
  };

  const shifts = requirements.length > 0 ? requirements : [defaultShift];

  if (titulares.length === 0) {
    warnings.push('No titular guards assigned to this station. Only sacafrancos will be scheduled.');
  }

  // Generate day-by-day schedule
  let dayCount = 0;
  const currentDate = new Date(start);

  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split('T')[0];

    for (const shiftReq of shifts) {
      const guardsNeeded = parseInt(shiftReq.guardsCount || shiftReq.guardsNeeded || '1', 10);

      for (let g = 0; g < guardsNeeded; g++) {
        // Determine which guard works this day
        const titularIndex = g % Math.max(titulares.length, 1);
        const titular = titulares[titularIndex];

        // Check if titular needs a rest day (every 5-6 days)
        const workRules = titular?.workRules || getDefaultWorkRules();
        const maxConsecutive = workRules.maxConsecutiveDays || 5;
        const isRestDay = dayCount > 0 && dayCount % (maxConsecutive + 1) >= maxConsecutive;

        // Check time-off
        const isOnTimeOff = context.timeOff.some((t: any) =>
          titular && t.guardId === titular.id &&
          dateStr >= t.startDate && dateStr <= t.endDate
        );

        const needsSacafranco = isRestDay || isOnTimeOff || !titular;

        const shiftStartTime = `${dateStr}T${shiftReq.startTime || defaultShift.startTime}:00.000Z`;
        const shiftEndTime = `${dateStr}T${shiftReq.endTime || defaultShift.endTime}:00.000Z`;

        if (needsSacafranco && sacafrancos.length > 0) {
          // Assign a sacafranco
          const sacafrancoIndex = dayCount % sacafrancos.length;
          const sacafranco = sacafrancos[sacafrancoIndex];

          proposedShifts.push({
            guardId: sacafranco.id,
            guardName: sacafranco.name,
            startTime: shiftStartTime,
            endTime: shiftEndTime,
            type: 'sacafranco',
          });

          sacafrancoAssignments.push({
            date: dateStr,
            sacafrancoId: sacafranco.id,
            sacafrancoName: sacafranco.name,
            coversFor: titular?.name || 'unassigned',
            reason: isOnTimeOff ? 'time off' : 'rest day',
          });
        } else if (titular) {
          proposedShifts.push({
            guardId: titular.id,
            guardName: titular.name,
            startTime: shiftStartTime,
            endTime: shiftEndTime,
            type: 'titular',
          });
        } else {
          warnings.push(`${dateStr}: No guard available for shift ${shiftReq.nombre || 'default'}`);
        }
      }
    }

    dayCount++;
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const titularShifts = proposedShifts.filter(s => s.type === 'titular').length;
  const sacafrancoShifts = proposedShifts.filter(s => s.type === 'sacafranco').length;

  return {
    proposedShifts,
    sacafrancoAssignments,
    summary: {
      totalShifts: proposedShifts.length,
      titularShifts,
      sacafrancoShifts,
      totalHours: proposedShifts.length * 12, // approximate
      overtimeHours: 0,
    },
    estimatedCost: {
      regularHours: proposedShifts.length * 12,
      overtimeHours: 0,
      totalRelativeCost: proposedShifts.length,
    },
    warnings,
  };
}
