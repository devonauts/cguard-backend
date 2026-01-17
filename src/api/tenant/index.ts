export default (app) => {
  app.post(
    `/tenant/invitation/:token/accept`,
    require('./tenantInvitationAccept').default,
  );
  app.delete(
    `/tenant/invitation/:token/decline`,
    require('./tenantInvitationDecline').default,
  );
  app.post(`/tenant`, require('./tenantCreate').default);
  app.put(`/tenant/:id`, require('./tenantUpdate').default);
  app.delete(`/tenant`, require('./tenantDestroy').default);
  app.get(`/tenant`, require('./tenantList').default);
  app.get(`/tenant/url/available`, require('./tenantUrlAvailable').default);
  app.get(`/tenant/url`, require('./tenantFind').default);
  app.get(`/tenant/:tenantId`, require('./tenantFind').default);
  app.post(`/tenant/:tenantId/tenant-user/invitation-token`, require('./tenantCreateInvitationToken').default);
};
