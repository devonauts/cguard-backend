import ApiResponseHandler from '../apiResponseHandler';
import Error400 from '../../errors/Error400';
import SchedulerService from '../../services/schedulerService';

export default async (req, res) => {
  try {
    const payload = await SchedulerService.generateSchedule(
      req.body,
      req,
    );

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
