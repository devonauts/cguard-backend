import { Op } from 'sequelize';
import ApiResponseHandler from '../apiResponseHandler';
import Error404 from '../../errors/Error404';

// GET /video/clip/shared/:token   (PUBLIC — no tenant, no permission)
// Return the clip if the token is valid and not expired, else 404.
export default async (req, res) => {
  try {
    const db = req.database;
    const token = req.params.token;
    if (!token) throw new Error404();

    const clip = await db.videoClip.findOne({
      where: {
        shareToken: token,
        shareExpiresAt: { [Op.gt]: new Date() },
      },
    });
    if (!clip) throw new Error404();

    await ApiResponseHandler.success(req, res, {
      label: clip.label,
      url: clip.url,
      thumbnailUrl: clip.thumbnailUrl,
      startAt: clip.startAt,
      endAt: clip.endAt,
    });
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
