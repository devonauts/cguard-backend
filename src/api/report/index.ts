export default (app) => {
  // Only reportList is live — the PostSiteKPIs and GuardKPIs pages read the
  // month's report rows via GET /tenant/:tenantId/report to tally per-guard /
  // per-station counts. The rest of the CRUD (create/update/destroy/import/
  // autocomplete/find) had zero callers and was removed.
  app.get(
    `/tenant/:tenantId/report`,
    require('./reportList').default,
  );
};
