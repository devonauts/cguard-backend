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
  schedulerOverview,
} from './schedulingEndpoints';

export default (app) => {
  // Rotation styles
  app.get('/tenant/:tenantId/rotation-styles', rotationStyleList);
  app.post('/tenant/:tenantId/rotation-style', rotationStyleCreate);

  // Station positions
  app.get('/tenant/:tenantId/station/:stationId/positions', stationPositionList);
  app.post('/tenant/:tenantId/station/:stationId/positions', stationPositionCreate);
  app.put('/tenant/:tenantId/station/:stationId/positions/:positionId', stationPositionUpdate);
  app.delete('/tenant/:tenantId/station/:stationId/positions/:positionId', stationPositionDelete);
  app.post('/tenant/:tenantId/station/:stationId/auto-positions', stationAutoPositions);

  // Guard assignments
  app.get('/tenant/:tenantId/guard-assignments', guardAssignmentList);
  app.post('/tenant/:tenantId/guard-assignment', guardAssignmentCreate);
  app.delete('/tenant/:tenantId/guard-assignment/:id', guardAssignmentDelete);

  // Scheduler overview (unified view)
  app.get('/tenant/:tenantId/scheduler/overview', schedulerOverview);
};
