import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TaskService from '../../services/taskService';
import StationService from '../../services/stationService';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(Permissions.values.taskRead);

    // Try to fetch tasks by postSite via station relation: find stations then tasks
    const stationParams = Object.assign({}, req.query || {}, { postSiteId: req.params.id });
    const stationsPayload = await new StationService(req).findAndCountAll(stationParams);
    const stationIds = (stationsPayload && stationsPayload.rows) ? stationsPayload.rows.map(s => s.id).filter(Boolean) : [];

    const taskParams = Object.assign({}, req.query || {});
    if (stationIds && stationIds.length) {
      taskParams.stationIds = stationIds;
    } else {
      // fallback: set postSiteId param so TaskService implementations that honor it can use it
      taskParams.postSiteId = req.params.id;
    }

    const payload = await new TaskService(req).findAndCountAll(taskParams);

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
