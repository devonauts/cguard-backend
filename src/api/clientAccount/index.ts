export default (app) => {
  app.post(
    `/tenant/:tenantId/client-account`,
    require('./clientAccountCreate').default,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id`,
    require('./clientAccountUpdate').default,
  );
  // Accept PATCH as an alternative to PUT for partial updates
  app.patch(
    `/tenant/:tenantId/client-account/:id`,
    require('./clientAccountUpdate').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/import`,
    require('./clientAccountImport').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/destroy-all`,
    require('./clientAccountDestroy').default,
  );
  app.delete(
    `/tenant/:tenantId/client-account`,
    require('./clientAccountDestroy').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/autocomplete`,
    require('./clientAccountAutocomplete').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/export`,
    require('./clientAccountExport').default,
  );
  app.get(
    `/tenant/:tenantId/client-account`,
    require('./clientAccountList').default,
  );
  // Static path registered BEFORE :id so "card-meta" isn't captured as an id.
  app.get(
    `/tenant/:tenantId/client-account/card-meta`,
    require('./clientAccountCardMeta').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/operation`,
    require('./clientAccountOperation').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id`,
    require('./clientAccountFind').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/post-sites`,
    require('./clientAccountPostSites').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/guards/count`,
    require('./clientAccountGuardsCount').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/incidents`,
    require('./clientAccountIncidents').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/overview`,
    require('./clientAccountOverview').default,
  );
  // Unified activity timeline (shifts, incidents, visitors, tasks, rondas, relevos).
  app.get(
    `/tenant/:tenantId/client-account/:id/activity`,
    require('./clientAccountActivity').default,
  );

  // Puestos y cobertura (live coverage per sede)
  app.get(
    `/tenant/:tenantId/client-account/:id/coverage`,
    require('./clientAccountCoverage').default,
  );

  // Personal asignado (live roster across sedes)
  app.get(
    `/tenant/:tenantId/client-account/:id/personnel`,
    require('./clientAccountPersonnel').default,
  );

  // Horario (schedule grid per sede)
  app.get(
    `/tenant/:tenantId/client-account/:id/schedule`,
    require('./clientAccountSchedule').default,
  );

  // Documentos (client document library)
  app.get(
    `/tenant/:tenantId/client-account/:id/documents`,
    require('./clientAccountDocuments').default,
  );

  // Reportes (client analytics + exports + scheduled reports)
  app.get(
    `/tenant/:tenantId/client-account/:id/reports`,
    require('./clientAccountReports').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/reports-export`,
    require('./clientAccountReportActions').exportCsv,
  );
  app.post(
    `/tenant/:tenantId/client-account/:id/report-schedules`,
    require('./clientAccountReportActions').createSchedule,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/report-schedules/:scheduleId`,
    require('./clientAccountReportActions').deleteSchedule,
  );

  // Incidentes board + detail actions
  app.get(
    `/tenant/:tenantId/client-account/:id/incidents-board`,
    require('./clientAccountIncidentsBoard').default,
  );
  app.get(
    `/tenant/:tenantId/client-account/:id/incident/:incidentId/evidence`,
    require('./clientAccountIncidentActions').evidence,
  );
  app.patch(
    `/tenant/:tenantId/client-account/:id/incident/:incidentId/status`,
    require('./clientAccountIncidentActions').updateStatus,
  );

  // Contract & services subpage
  app.get(
    `/tenant/:tenantId/client-account/:id/contract`,
    require('./clientAccountContract').default,
  );
  app.patch(
    `/tenant/:tenantId/client-account/:id/contract`,
    require('./clientAccountContractUpdate').default,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id/contract`,
    require('./clientAccountContractUpdate').default,
  );
  // Contracted services CRUD
  app.post(
    `/tenant/:tenantId/client-account/:id/contract-services`,
    require('./contractServiceWrite').create,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id/contract-services/:serviceId`,
    require('./contractServiceWrite').update,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/contract-services/:serviceId`,
    require('./contractServiceWrite').destroy,
  );
  // Renewal history CRUD
  app.post(
    `/tenant/:tenantId/client-account/:id/contract-renewals`,
    require('./contractRenewalWrite').create,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id/contract-renewals/:renewalId`,
    require('./contractRenewalWrite').update,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/contract-renewals/:renewalId`,
    require('./contractRenewalWrite').destroy,
  );
  // Client contacts CRUD
  app.get(
    `/tenant/:tenantId/client-account/:id/contacts`,
    require('./clientAccountContacts').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/:id/contacts`,
    require('./clientAccountContactCreate').default,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id/contacts/:contactId`,
    require('./clientAccountContactUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/contacts/:contactId`,
    require('./clientAccountContactDestroy').default,
  );

  // Client notes CRUD
  app.get(
    `/tenant/:tenantId/client-account/:id/notes`,
    require('./clientAccountNotes').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/:id/notes`,
    require('./clientAccountNoteCreate').default,
  );
  app.put(
    `/tenant/:tenantId/client-account/:id/notes/:noteId`,
    require('./clientAccountNoteUpdate').default,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/notes/:noteId`,
    require('./clientAccountNoteDestroy').default,
  );

  // App-access users (titular + additional via pivot)
  app.get(
    `/tenant/:tenantId/client-account/:id/access-users`,
    require('./clientAccountAccessUsers').list,
  );
  app.delete(
    `/tenant/:tenantId/client-account/:id/access-users/:pivotId`,
    require('./clientAccountAccessUsers').revoke,
  );

  app.post(
    `/tenant/:tenantId/client-account/:id/send-portal-invitation`,
    require('./clientAccountSendPortalInvitation').default,
  );
  app.post(
    `/tenant/:tenantId/client-account/:id/send-app-invitation`,
    require('./clientAccountSendAppInvitation').default,
  );
};
