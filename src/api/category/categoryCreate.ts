/** @openapi { "summary": "Create category", "description": "Create a category for a specific module (e.g., clientAccount, products)", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "name": { "type": "string" }, "description": { "type": "string" }, "module": { "type": "string" }, "importHash": { "type": "string" } }, "required": ["name","module"] } } } }, "responses": { "200": { "description": "Created" }, "400": { "description": "Validation error" } } } */

import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import CategoryService from '../../services/categoryService';

export default async (req, res, next) => {
    try {
        new PermissionChecker(req).validateHas(
            Permissions.values.categoryCreate,
        );

        const payload = await new CategoryService(req).create(
            req.body,
        );

        await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
        await ApiResponseHandler.error(req, res, error);
    }
};
