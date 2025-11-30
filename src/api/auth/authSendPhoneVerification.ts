import ApiResponseHandler from '../apiResponseHandler';
import { SendPhoneVerificationUseCase } from '../../modules/auth/application/PhoneVerificationUseCases';
import { SequelizeUserRepositoryAdapter } from '../../modules/auth/infrastructure/SequelizeUserRepositoryAdapter';
import Error403 from '../../errors/Error403';

export default async (req, res, next) => {
    try {
        if (!req.currentUser || !req.currentUser.id) {
            throw new Error403(req.language);
        }

        const userRepository = new SequelizeUserRepositoryAdapter();
        const useCase = new SendPhoneVerificationUseCase(userRepository);

        const result = await useCase.execute(req.currentUser, req.body.phoneNumber, req);

        await ApiResponseHandler.success(req, res, result);
    } catch (error) {
        await ApiResponseHandler.error(req, res, error);
    }
};
