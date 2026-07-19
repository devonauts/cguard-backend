export default (app) => {
  app.post(
    `/tenant/:tenantId/guard-shift`,
    require('./guardShiftCreate').default,
  );
  app.delete(
    `/tenant/:tenantId/guard-shift`,
    require('./guardShiftDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/guard-shift`,
    require('./guardShiftList').default,
  );
};
