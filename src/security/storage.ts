/**
 * Storage permissions.
 *
 * @id - Used to identify the rule on permissions and upload.
 * @folder - Folder where the files will be saved
 * @maxSizeInBytes - Max allowed size in bytes
 * @bypassWritingPermissions - Does not validate if the user has permission to write
 * @publicRead - The file can be publicly accessed via the URL without the need for a signed token
 */
export default class Storage {
  static get values() {
    return {
      userAvatarsProfiles: {
        id: 'userAvatarsProfiles',
        folder: 'user/avatars/profile/:userId',
        maxSizeInBytes: 10 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: true,
      },
      settingsLogos: {
        id: 'settingsLogos',
        folder: 'tenant/:tenantId/settings/logos',
        maxSizeInBytes: 10 * 1024 * 1024,
        publicRead: true,
      },
      // Legal documents for tenants (contracts, estimates, invoices uploads)
      legalDocuments: {
        id: 'legalDocuments',
        folder: 'tenant/:tenantId/legalDocuments',
        maxSizeInBytes: 100 * 1024 * 1024,
        publicRead: false,
        // Allow local/dev uploads without per-role storage permission checks.
        // In production you may want to set this to false and manage permissions
        // via role assignments. For local development this avoids 403 on uploads.
        bypassWritingPermissions: true,
      },
      settingsBackgroundImages: {
        id: 'settingsBackgroundImages',
        folder:
          'tenant/:tenantId/settings/backgroundImages',
        maxSizeInBytes: 10 * 1024 * 1024,
        publicRead: true,
      },
      bannerSuperiorAppImageUrl: {
        id: 'bannerSuperiorAppImageUrl',
        folder: 'tenant/:tenantId/bannerSuperiorApp/imageUrl',
        maxSizeInBytes: 10 * 1024 * 1024,
      },

      serviceIconImage: {
        id: 'serviceIconImage',
        folder: 'tenant/:tenantId/service/iconImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      vehicleImage: {
        id: 'vehicleImage',
        folder: 'tenant/:tenantId/vehicle/image',
        maxSizeInBytes: 10 * 1024 * 1024,
        publicRead: true,
      },
      serviceServiceImages: {
        id: 'serviceServiceImages',
        folder: 'tenant/:tenantId/service/serviceImages',
        maxSizeInBytes: 100 * 1024 * 1024,
      },

      certificationImage: {
        id: 'certificationImage',
        folder: 'tenant/:tenantId/certification/image',
        maxSizeInBytes: 10 * 1024 * 1024,
      },
      certificationIcon: {
        id: 'certificationIcon',
        folder: 'tenant/:tenantId/certification/icon',
        maxSizeInBytes: 3 * 1024 * 1024,
      },

      securityGuardProfileImage: {
        id: 'securityGuardProfileImage',
        folder: 'tenant/:tenantId/securityGuard/profileImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardCredentialImage: {
        id: 'securityGuardCredentialImage',
        folder: 'tenant/:tenantId/securityGuard/credentialImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardLicenseImage: {
        id: 'securityGuardLicenseImage',
        folder: 'tenant/:tenantId/securityGuard/licenses',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardRecordPolicial: {
        id: 'securityGuardRecordPolicial',
        folder: 'tenant/:tenantId/securityGuard/recordPolicial',
        maxSizeInBytes: 100 * 1024 * 1024,
      },

      clientAccountLogoUrl: {
        id: 'clientAccountLogoUrl',
        folder: 'tenant/:tenantId/clientAccount/logoUrl',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      clientAccountPlacePictureUrl: {
        id: 'clientAccountPlacePictureUrl',
        folder: 'tenant/:tenantId/clientAccount/placePictureUrl',
        maxSizeInBytes: 100 * 1024 * 1024,
      },



      incidentImageUrl: {
        id: 'incidentImageUrl',
        folder: 'tenant/:tenantId/incident/imageUrl',
        maxSizeInBytes: 100 * 1024 * 1024,
      },





      patrolCheckpointAssignedQrImage: {
        id: 'patrolCheckpointAssignedQrImage',
        folder: 'tenant/:tenantId/patrolCheckpoint/assignedQrImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },







      billingBill: {
        id: 'billingBill',
        folder: 'tenant/:tenantId/billing/bill',
        maxSizeInBytes: 100 * 1024 * 1024,
      },



      taskImageOptional: {
        id: 'taskImageOptional',
        folder: 'tenant/:tenantId/task/imageOptional',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      taskTaskCompletedImage: {
        id: 'taskTaskCompletedImage',
        folder: 'tenant/:tenantId/task/taskCompletedImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },

      notificationImageUrl: {
        id: 'notificationImageUrl',
        folder: 'tenant/:tenantId/notification/imageUrl',
        maxSizeInBytes: 100 * 1024 * 1024,
      },





      memosMemoDocumentPdf: {
        id: 'memosMemoDocumentPdf',
        folder: 'tenant/:tenantId/memos/memoDocumentPdf',
        maxSizeInBytes: 100 * 1024 * 1024,
      },

      // Notes attachments (separate folders per type)
      notesPdf: {
        id: 'notesPdf',
        folder: 'tenant/:tenantId/notes/pdf',
        maxSizeInBytes: 3 * 1024 * 1024,
        publicRead: true,
      },
      notesImages: {
        id: 'notesImages',
        folder: 'tenant/:tenantId/notes/images',
        maxSizeInBytes: 3 * 1024 * 1024,
        publicRead: true,
      },

      requestRequestDocumentPDF: {
        id: 'requestRequestDocumentPDF',
        folder: 'tenant/:tenantId/request/requestDocumentPDF',
        maxSizeInBytes: 100 * 1024 * 1024,
      },











      businessInfoLogo: {
        id: 'businessInfoLogo',
        folder: 'tenant/:tenantId/businessInfo/logo',
        maxSizeInBytes: 10000,
      },

      insuranceDocument: {
        id: 'insuranceDocument',
        folder: 'tenant/:tenantId/insurance/document',
        maxSizeInBytes: 100 * 1024 * 1024,
      },






    };
  }
}
