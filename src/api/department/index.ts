/**
 * Departamentos — the tenant's internal org structure (Settings › Departamentos).
 *
 * Read is open to staff (settingsRead: selects/filters need it); writes are
 * gated by settingsEdit — deliberately REUSING existing permissions so no new
 * permission id has to propagate to existing tenants' frozen role snapshots.
 *
 * Routes:
 *   GET    /tenant/:tenantId/department                 list (+ member counts)
 *   POST   /tenant/:tenantId/department                 create
 *   PUT    /tenant/:tenantId/department/:id             update (name/desc/manager/active)
 *   DELETE /tenant/:tenantId/department/:id             soft-delete (blocked if it has members)
 *   GET    /tenant/:tenantId/department-member/:userId   read a member's department
 *   PUT    /tenant/:tenantId/department-member/:userId  assign/unassign a member
 */
export default (app) => {
  app.get(`/tenant/:tenantId/department`, require('./departmentList').default);
  app.post(`/tenant/:tenantId/department`, require('./departmentCreate').default);
  app.put(`/tenant/:tenantId/department/:id`, require('./departmentUpdate').default);
  app.delete(`/tenant/:tenantId/department/:id`, require('./departmentDestroy').default);
  app.get(`/tenant/:tenantId/department-member/:userId`, require('./departmentMemberGet').default);
  app.put(`/tenant/:tenantId/department-member/:userId`, require('./departmentAssignMember').default);
};
