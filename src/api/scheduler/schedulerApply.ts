import ApiResponseHandler from '../apiResponseHandler';
import SchedulerService from '../../services/schedulerService';

export default async (req, res) => {
  try {
    const result = await SchedulerService.applySchedule(
      req.body,
      req,
    );

    await ApiResponseHandler.success(req, res, result);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
