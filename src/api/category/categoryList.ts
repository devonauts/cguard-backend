import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CategoryService from '../../services/categoryService';

export default async (req, res, next) => {
    try {
        new PermissionChecker(req).validateHas(
            Permissions.values.categoryRead,
        );

        console.log('📥 [CategoryList] query params:', req.query);
        const payload = await new CategoryService(
            req,
        ).findAndCountAll(req.query);
        console.log('📤 [CategoryList] rows:', payload?.rows?.length, 'count:', payload?.count);

        await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
        await ApiResponseHandler.error(req, res, error);
    }
};
