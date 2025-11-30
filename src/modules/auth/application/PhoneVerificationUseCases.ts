import { IUserRepository } from '../domain/IUserRepository';
import SequelizeRepository from '../../../database/repositories/sequelizeRepository';

// Simple in-memory store for verification codes (in production, use Redis or database)
const verificationCodes = new Map<string, { code: string; expiresAt: number }>();

export class SendPhoneVerificationUseCase {
    private userRepository: IUserRepository;

    constructor(userRepository: IUserRepository) {
        this.userRepository = userRepository;
    }

    async execute(currentUser: any, phoneNumber: string, options: any) {
        if (!currentUser || !currentUser.id) {
            throw new Error('User is required');
        }

        if (!phoneNumber) {
            throw new Error('Phone number is required');
        }

        // Generate 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        // Store code with 10-minute expiration
        const expiresAt = Date.now() + 10 * 60 * 1000;
        verificationCodes.set(currentUser.id, { code, expiresAt });

        // TODO: In production, send SMS via Twilio, AWS SNS, or similar service
        // For now, we'll just log it (you can see it in console)
        console.log(`[PHONE VERIFICATION] Code for ${phoneNumber}: ${code}`);

        return { message: 'Verification code sent', code }; // Remove 'code' in production
    }
}

export class VerifyPhoneUseCase {
    private userRepository: IUserRepository;

    constructor(userRepository: IUserRepository) {
        this.userRepository = userRepository;
    }

    async execute(currentUser: any, code: string, phoneNumber: string, options: any) {
        if (!currentUser || !currentUser.id) {
            throw new Error('User is required');
        }

        if (!code) {
            throw new Error('Verification code is required');
        }

        const storedData = verificationCodes.get(currentUser.id);

        if (!storedData) {
            throw new Error('No verification code found. Please request a new code.');
        }

        if (Date.now() > storedData.expiresAt) {
            verificationCodes.delete(currentUser.id);
            throw new Error('Verification code expired. Please request a new code.');
        }

        if (storedData.code !== code) {
            throw new Error('Invalid verification code.');
        }

        // Code is valid, update user's phone as verified
        const transaction = await SequelizeRepository.createTransaction(options.database);

        try {
            await this.userRepository.updatePhoneVerification(
                currentUser.id,
                phoneNumber,
                true,
                { ...options, transaction }
            );

            // Clean up the verification code
            verificationCodes.delete(currentUser.id);

            await SequelizeRepository.commitTransaction(transaction);
        } catch (error) {
            await SequelizeRepository.rollbackTransaction(transaction);
            throw error;
        }
    }
}
