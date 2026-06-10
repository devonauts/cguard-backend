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
        // Store user avatars under tenant-scoped folder so files are
        // organized by tenant and user: uploads/tenant/<tenantId>/user/<userId>/avatar
        folder: 'tenant/:tenantId/user/:userId/avatar',
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
      securityGuardIdentificationImage: {
        id: 'securityGuardIdentificationImage',
        folder: 'tenant/:tenantId/securityGuard/identificationImage',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardAfisCertificate: {
        id: 'securityGuardAfisCertificate',
        folder: 'tenant/:tenantId/securityGuard/afisCertificate',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardMedicalCertificate: {
        id: 'securityGuardMedicalCertificate',
        folder: 'tenant/:tenantId/securityGuard/medicalCertificate',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardPsychologicalCertificate: {
        id: 'securityGuardPsychologicalCertificate',
        folder: 'tenant/:tenantId/securityGuard/psychologicalCertificate',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardCredentialDocument: {
        id: 'securityGuardCredentialDocument',
        folder: 'tenant/:tenantId/securityGuard/credentialDocument',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardCertificationLevel1: {
        id: 'securityGuardCertificationLevel1',
        folder: 'tenant/:tenantId/securityGuard/certificationLevel1',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardCertificationLevel2: {
        id: 'securityGuardCertificationLevel2',
        folder: 'tenant/:tenantId/securityGuard/certificationLevel2',
        maxSizeInBytes: 100 * 1024 * 1024,
      },
      securityGuardFamilyViolenceCertificate: {
        id: 'securityGuardFamilyViolenceCertificate',
        folder: 'tenant/:tenantId/securityGuard/familyViolenceCertificate',
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

      inventoryItemPhotos: {
        id: 'inventoryItemPhotos',
        folder: 'tenant/:tenantId/inventoryItem/photos',
        maxSizeInBytes: 20 * 1024 * 1024,
        publicRead: true,
      },

      visitorLogIdPhoto: {
        id: 'visitorLogIdPhoto',
        folder: 'tenant/:tenantId/visitorLog/idPhoto',
        maxSizeInBytes: 10 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: false,
      },

      // Geo-stamped clock-in/out selfie taken by the guard at their post.
      guardShiftSelfie: {
        id: 'guardShiftSelfie',
        folder: 'tenant/:tenantId/guardShift/selfie',
        maxSizeInBytes: 10 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: false,
      },

      // Evidence (photo / video / audio voice-note) for a completed consigna.
      guardConsignaMedia: {
        id: 'guardConsignaMedia',
        folder: 'tenant/:tenantId/consigna/media',
        maxSizeInBytes: 60 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: false,
      },

      // Image / video attachments sent in a message thread (CRM + worker app).
      messageAttachments: {
        id: 'messageAttachments',
        folder: 'tenant/:tenantId/message/attachments',
        maxSizeInBytes: 100 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: false,
      },

      // Voice reply clips for the radio check (pase de novedades). OpenAI's
      // transcription cap is 25 MB; voice replies are tiny. Private.
      radioCheckAudio: {
        id: 'radioCheckAudio',
        folder: 'tenant/:tenantId/radioCheck/audio',
        maxSizeInBytes: 25 * 1024 * 1024,
        bypassWritingPermissions: true,
        publicRead: false,
      },


    };
  }
}
