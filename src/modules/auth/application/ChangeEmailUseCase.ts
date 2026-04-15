import { IUserRepository } from '../domain/IUserRepository';
import SequelizeRepository from '../../../database/repositories/sequelizeRepository';
import bcrypt from 'bcryptjs';
import Error403 from '../../../errors/Error403';
import Error400 from '../../../errors/Error400';
import AuthService from '../../../services/auth/authService';

export class ChangeEmailUseCase {
    private userRepository: IUserRepository;

    constructor(userRepository: IUserRepository) {
        this.userRepository = userRepository;
    }

    async execute(currentUser: any, payload: any, options: any) {
        if (!currentUser || !currentUser.id) {
            throw new Error403(options.language);
        }

        if (!payload.newEmail || !payload.password) {
            throw new Error400(options.language, 'auth.emailChange.missingFields');
        }

        const transaction = await SequelizeRepository.createTransaction(options.database);

        try {
            // 1. Verify Password - findPassword returns just the password hash string
            const passwordHash = await this.userRepository.findByIdWithPassword(currentUser.id, { ...options, transaction });

            if (!passwordHash) {
                throw new Error403(options.language);
            }

            const passwordIsValid = await bcrypt.compare(payload.password, passwordHash);

            if (!passwordIsValid) {
                throw new Error400(options.language, 'auth.passwordReset.error');
            }

            // 2. Update Email
            await this.userRepository.changeEmail(currentUser.id, payload.newEmail, { ...options, transaction });

            // 3. Send verification email to the new address
            await AuthService.sendEmailAddressVerificationEmail(
                options.language,
                payload.newEmail,
                options.currentTenant ? options.currentTenant.id : undefined,
                { ...options, transaction },
            );

            await SequelizeRepository.commitTransaction(transaction);
        } catch (error) {
            await SequelizeRepository.rollbackTransaction(transaction);
            throw error;
        }
    }
}
