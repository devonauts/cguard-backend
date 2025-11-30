import { IUserRepository } from '../domain/IUserRepository';
import SequelizeRepository from '../../../database/repositories/sequelizeRepository';

export class UpdateProfileUseCase {
    private userRepository: IUserRepository;

    constructor(userRepository: IUserRepository) {
        this.userRepository = userRepository;
    }

    async execute(currentUser: any, data: any, options: any) {
        if (!currentUser || !currentUser.id) {
            throw new Error('User is required');
        }

        if (!data) {
            throw new Error('Profile data is required');
        }

        // Transaction management could be abstracted, but for now we use the existing pattern
        // adapted to be slightly more decoupled (Use Case orchestrates it)
        let transaction = null;

        try {
            transaction = await SequelizeRepository.createTransaction(options.database);

            const result = await this.userRepository.updateProfile(
                currentUser.id,
                data,
                {
                    ...options,
                    transaction, // Pass the transaction to the repository
                    bypassPermissionValidation: true,
                }
            );

            await SequelizeRepository.commitTransaction(transaction);
            return result;
        } catch (error) {
            if (transaction) {
                await SequelizeRepository.rollbackTransaction(transaction);
            }
            throw error;
        }
    }
}
