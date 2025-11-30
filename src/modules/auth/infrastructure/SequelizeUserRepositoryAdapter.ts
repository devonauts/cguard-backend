import { IUserRepository } from '../domain/IUserRepository';
import UserRepository from '../../../database/repositories/userRepository';

export class SequelizeUserRepositoryAdapter implements IUserRepository {
    async updateProfile(id: string, data: any, options: any): Promise<any> {
        return UserRepository.updateProfile(id, data, options);
    }

    async changeEmail(id: string, newEmail: string, options: any): Promise<any> {
        return UserRepository.changeEmail(id, newEmail, options);
    }

    async findByIdWithPassword(id: string, options: any): Promise<any> {
        return UserRepository.findPassword(id, options);
    }

    async updatePhoneVerification(id: string, phoneNumber: string, verified: boolean, options: any): Promise<any> {
        return UserRepository.update(id, { phoneNumber, phoneNumberVerified: verified }, options);
    }
}
