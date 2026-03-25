import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import IncidentService from '../../services/incidentService';
import { i18n } from '../../i18n';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.requestCreate,
    );

    // Map incoming request payload to incident model shape
    const data = req.body && req.body.data ? req.body.data : {};
    const incidentPayload: any = {
      date: data.incidentAt || data.dateTime || null,
      title: data.subject || null,
      description: data.content || data.incidentDetails || null,
      // stationIncidents expects station id
      stationIncidents: data.stationId || data.station || null,
      incidentType: data.incidentTypeId || data.incidentType || null,
    };

    const payload = await new IncidentService(req).create(incidentPayload);

    const lang = req && req.language ? req.language : undefined;
    const messageCode = 'request.created';
    const message = i18n(lang, messageCode);

    const responsePayload = {
      messageCode,
      message,
      data: payload,
    };

    await ApiResponseHandler.success(req, res, responsePayload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
