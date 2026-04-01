export default (app) => {
  app.post(
    `/file/upload`,
    require('./localhost/upload').default,
  );
  app.get(
    `/file/download`,
    require('./localhost/download').default,
  );
  app.get(
    `/tenant/:tenantId/file/credentials`,
    require('./credentials').default,
  );
  // Attachments endpoints (metadata)
  app.post(
    `/tenant/:tenantId/attachments`,
    require('../attachment/create').default,
  );
  app.get(
    `/tenant/:tenantId/attachments`,
    require('../attachment/list').default,
  );
  app.delete(
    `/tenant/:tenantId/attachments/:id`,
    require('../attachment/destroy').default,
  );
};
