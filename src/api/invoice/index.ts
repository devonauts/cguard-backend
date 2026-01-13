export default (app) => {
  app.post(
    `/tenant/:tenantId/invoice`,
    require('./invoiceCreate').default,
  );
};
