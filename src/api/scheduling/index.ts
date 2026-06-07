import {
  rotationStyleList,
  rotationStyleCreate,
  stationPositionList,
  stationPositionCreate,
  stationPositionUpdate,
  stationPositionDelete,
  guardAssignmentList,
  guardAssignmentCreate,
  guardAssignmentDelete,
  stationAutoPositions,
  stationGenerateYearly,
  schedulerOverview,
  schedulerStaffing,
  schedulerAutoAssign,
  schedulerOptimizeSacafrancos,
  schedulerAiRecommend,
  scheduleOverrideList,
  scheduleOverrideCreate,
  scheduleOverrideDelete,
} from './schedulingEndpoints';
import {
  proposalGenerate,
  proposalGet,
  proposalPublish,
  proposalDiscard,
} from './proposalEndpoints';

export default (app) => {
  // Rotation styles
  app.get('/tenant/:tenantId/rotation-styles', rotationStyleList);
  app.post('/tenant/:tenantId/rotation-style', rotationStyleCreate);
  app.post('/tenant/:tenantId/rotation-styles', rotationStyleCreate);

  // Station positions
  app.get('/tenant/:tenantId/station/:stationId/positions', stationPositionList);
  app.post('/tenant/:tenantId/station/:stationId/positions', stationPositionCreate);
  app.put('/tenant/:tenantId/station/:stationId/positions/:positionId', stationPositionUpdate);
  app.delete('/tenant/:tenantId/station/:stationId/positions/:positionId', stationPositionDelete);
  app.post('/tenant/:tenantId/station/:stationId/auto-positions', stationAutoPositions);
  app.post('/tenant/:tenantId/station/:stationId/generate-yearly', stationGenerateYearly);

  // Guard assignments
  app.get('/tenant/:tenantId/guard-assignments', guardAssignmentList);
  app.post('/tenant/:tenantId/guard-assignment', guardAssignmentCreate);
  app.delete('/tenant/:tenantId/guard-assignment/:id', guardAssignmentDelete);

  // Scheduler overview (unified view)
  app.get('/tenant/:tenantId/scheduler/overview', schedulerOverview);
  app.get('/tenant/:tenantId/scheduler/staffing', schedulerStaffing);
  app.post('/tenant/:tenantId/scheduler/auto-assign', schedulerAutoAssign);
  app.post('/tenant/:tenantId/scheduler/optimize-sacafrancos', schedulerOptimizeSacafrancos);

  // Draft horario proposals (generate → review/diff → publish/discard)
  app.post('/tenant/:tenantId/scheduler/proposals', proposalGenerate);
  app.get('/tenant/:tenantId/scheduler/proposals/:id', proposalGet);
  app.post('/tenant/:tenantId/scheduler/proposals/:id/publish', proposalPublish);
  app.post('/tenant/:tenantId/scheduler/proposals/:id/discard', proposalDiscard);

  // AI scheduling recommendations
  app.post('/tenant/:tenantId/scheduler/ai-recommend', schedulerAiRecommend);

  // Schedule overrides (vacations, permissions, absences, manual shifts)
  app.get('/tenant/:tenantId/schedule-overrides', scheduleOverrideList);
  app.post('/tenant/:tenantId/schedule-overrides', scheduleOverrideCreate);
  app.delete('/tenant/:tenantId/schedule-overrides/:id', scheduleOverrideDelete);
};
