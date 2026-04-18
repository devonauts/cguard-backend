/** @openapi { "summary": "Dispatch an incident (create a Request from incident)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "clientId": { "type": "string" }, "siteId": { "type": "string" }, "stationId": { "type": "string" }, "guardId": { "type": "string" }, "incidentAt": { "type": "string", "format": "date-time" }, "incidentTypeId": { "type": "string" }, "content": { "type": "string" }, "location": { "type": "string" }, "priority": { "type": "string" }, "callerType": { "type": "string" }, "callerName": { "type": "string" }, "internalNotes": { "type": "string" }, "status": { "type": "string" }, "subject": { "type": "string" } }, "required": [] } } } }, "responses": { "200": { "description": "Created request (dispatch)" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentService from '../../services/incidentService';
import RequestService from '../../services/requestService';

export default async (req, res, next) => {
  try {
    // require permission to create requests/dispatches
    new PermissionChecker(req).validateHas(
      Permissions.values.requestCreate,
    );

    const { id } = req.params;
    if (!id) {
      throw new Error('Incident id is required');
    }

    // load incident
    const incident = await new IncidentService(req).findById(id);

    // Build payload for request creation
    // Allow caller to override some fields via body.data
    const override = (req.body && req.body.data) ? req.body.data : {};

    const payload: any = {
      clientId: override.clientId || incident.clientId || incident.clientAccountId || null,
      siteId: override.siteId || incident.postSiteId || incident.siteId || null,
      stationId: override.stationId || incident.stationId || null,
      guardId: override.guardId || incident.guardId || null,
      incidentAt: override.incidentAt || incident.date || incident.createdAt || null,
      incidentTypeId: override.incidentTypeId || incident.incidentTypeId || null,
      content: override.content || incident.description || incident.content || '',
      location: override.location || incident.location || null,
      priority: override.priority || 'media',
      callerType: override.callerType || '',
      callerName: override.callerName || '',
      internalNotes: override.internalNotes || '',
      status: override.status || 'abierto',
      subject: override.subject || (`Incidente desde incidente ${incident.id}`),
    };

    const created = await new RequestService(req).create(payload);

    await ApiResponseHandler.success(req, res, created);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
