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
