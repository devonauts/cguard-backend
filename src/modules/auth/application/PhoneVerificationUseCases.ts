import { IUserRepository } from '../domain/IUserRepository';
import SequelizeRepository from '../../../database/repositories/sequelizeRepository';

// Simple in-memory store for verification codes (in production, use Redis or database)
const verificationCodes = new Map<string, { code: string; expiresAt: number }>();

// Sweep expired codes so abandoned verifications (requested but never confirmed)
// don't accumulate in the Map forever. Unref'd so it never keeps the worker up.
const _codeSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of verificationCodes) {
    if (!v || v.expiresAt < now) verificationCodes.delete(k);
  }
}, 5 * 60 * 1000);
if (_codeSweep && typeof (_codeSweep as any).unref === 'function') (_codeSweep as any).unref();

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

        // Deliver the OTP through the unified communications layer (WhatsApp
        // AUTHENTICATION template when preferred+enabled, else SMS — router
        // wallet-gates and logs the attempt). Best-effort: verification still
        // works in dev / on send failure via the console fallback below.
        let delivered = false;
        const db = options?.database;
        const tenantId = options?.currentTenant?.id || null;
        if (db && tenantId) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { sendOtp } = require('../../../services/communication/communicationService');
                const { results } = await sendOtp(db, {
                    tenantId,
                    userId: currentUser.id,
                    phone: phoneNumber,
                    code,
                });
                delivered = (results || []).some(
                    (r: any) => r && (r.status === 'sent' || r.status === 'delivered' || r.status === 'read'),
                );
            } catch (e: any) {
                console.error('[PhoneVerification] OTP send failed:', e?.message || e);
            }
        }

        // Dev/fallback visibility: keep the code reachable when nothing was
        // delivered (missing tenant/channels) or outside production.
        if (!delivered || process.env.NODE_ENV !== 'production') {
            console.log(`[PHONE VERIFICATION] Code for ${phoneNumber}: ${code}`);
        }

        // Echo the code back only outside production (dev/test flows rely on it).
        return {
            message: 'Verification code sent',
            delivered,
            ...(process.env.NODE_ENV !== 'production' ? { code } : {}),
        };
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
