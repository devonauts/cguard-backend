export interface IUserRepository {
    updateProfile(id: string, data: any, options: any): Promise<any>;
    changeEmail(id: string, newEmail: string, options: any): Promise<any>;
    findByIdWithPassword(id: string, options: any): Promise<any>;
    updatePhoneVerification(id: string, phoneNumber: string, verified: boolean, options: any): Promise<any>;
}
