/**
 * Performance-score capture endpoints (supervisor / admin facing):
 *   - uniform inspections
 *   - quiz bank management
 *   - backup-event confirmation
 *   - supervisor performance score
 *
 * Guard-facing endpoints (take quiz, volunteer) live under /guard/me/* in
 * api/guard. The score itself is served by securityGuardPerformance (guards)
 * and supervisorPerformance (supervisors).
 */
export default (app) => {
  // Uniform inspections
  app.post(
    `/tenant/:tenantId/uniform-inspection`,
    require('./uniformInspectionCreate').default,
  );
  app.get(
    `/tenant/:tenantId/security-guard/:id/uniform-inspections`,
    require('./uniformInspectionList').default,
  );

  // Quiz bank management (station-scoped)
  app.get(
    `/tenant/:tenantId/station/:stationId/quiz-bank`,
    require('./quizBankGet').default,
  );
  app.put(
    `/tenant/:tenantId/station/:stationId/quiz-bank`,
    require('./quizBankUpsert').default,
  );
  app.post(
    `/tenant/:tenantId/quiz-bank/:bankId/questions`,
    require('./quizQuestionUpsert').default,
  );
  app.put(
    `/tenant/:tenantId/quiz-bank/:bankId/questions/:questionId`,
    require('./quizQuestionUpsert').default,
  );
  app.delete(
    `/tenant/:tenantId/quiz-bank/:bankId/questions/:questionId`,
    require('./quizQuestionDelete').default,
  );

  // Backup events
  app.get(
    `/tenant/:tenantId/backup-event`,
    require('./backupEventList').default,
  );
  app.post(
    `/tenant/:tenantId/backup-event/:id/confirm`,
    require('./backupEventConfirm').default,
  );
  app.post(
    `/tenant/:tenantId/backup-event/:id/reject`,
    require('./backupEventConfirm').default,
  );

  // Supervisor performance score
  app.get(
    `/tenant/:tenantId/supervisor/:id/performance`,
    require('./supervisorPerformance').default,
  );
};
