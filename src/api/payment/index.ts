export default (app) => {
  app.post(
    `/tenant/:tenantId/payment`,
    require('./paymentCreate').default,
  );
};
