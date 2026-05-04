export default (app) => {
  // Global project list (all clients)
  app.get(
    `/tenant/:tenantId/client-project`,
    require('./clientProjectList').default,
  );
  app.get(
    `/tenant/:tenantId/client-project/:id`,
    require('./clientProjectFind').default,
  );
  app.post(
    `/tenant/:tenantId/client-project`,
    require('./clientProjectCreate').default,
  );
  app.put(
    `/tenant/:tenantId/client-project/:id`,
    require('./clientProjectUpdate').default,
  );
  app.patch(
    `/tenant/:tenantId/client-project/:id`,
    require('./clientProjectUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/client-project`,
    require('./clientProjectDestroy').default,
  );

  // Projects scoped to a specific client account
  app.get(
    `/tenant/:tenantId/client-account/:id/projects`,
    require('./clientProjectList').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/:id/projects`,
    (req, res) => {
      // inject clientAccountId from URL param into body
      req.body = { ...req.body, clientAccountId: req.params.id };
      return require('./clientProjectCreate').default(req, res);
    },
  );
};
