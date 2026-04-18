/** @openapi { "summary": "Change current user's email", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "newEmail": { "type": "string" }, "password": { "type": "string" } }, "required": ["newEmail","password"] } } } }, "responses": { "200": { "description": "Email change requested" }, "400": { "description": "Validation error" }, "403": { "description": "Forbidden" } } } */

import ApiResponseHandler from '../apiResponseHandler';
import { ChangeEmailUseCase } from '../../modules/auth/application/ChangeEmailUseCase';
import { SequelizeUserRepositoryAdapter } from '../../modules/auth/infrastructure/SequelizeUserRepositoryAdapter';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
    try {
        if (!req.currentUser || !req.currentUser.id) {
            throw new Error403(req.language);
        }

        const userRepository = new SequelizeUserRepositoryAdapter();
        const useCase = new ChangeEmailUseCase(userRepository);

        await useCase.execute(req.currentUser, req.body, req);

        const payload = true;

        await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
        await ApiResponseHandler.error(req, res, error);
    }
};
