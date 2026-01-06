/**
 * I18n dictionary for the en.
 */

const en = {
  app: {
    title: 'Application',
  },
    role: {
      errors: {
        inUse: 'Cannot delete role because it is in use by {0} user(s).',
      }
    },

  auth: {
    userNotFound: 'The email is not registered.',
    wrongPassword: 'The password is incorrect.',
    emailNotVerified: 'Email not verified. Check your inbox.',
    weakPassword: 'This password is too weak',
    emailAlreadyInUse: 'Email is already in use',
    invalidEmail: 'Please provide a valid email',
    passwordReset: {
      invalidToken:
        'Password reset link is invalid or has expired',
      error: `Email not recognized`,
    },
    emailAddressVerificationEmail: {
      invalidToken:
        'Email verification link is invalid or has expired.',
      error: `Email not recognized.`,
      signedInAsWrongUser: `This email confirmation was sent to {0} but you're signed in as {1}.`,
    },
    passwordChange: {
      invalidPassword: 'The old password is invalid',
    },
  },

  user: {
    errors: {
      userAlreadyExists:
        'User with this email already exists.',
      userNotFound: 'User not found.',
      destroyingHimself: `You can't delete yourself.`,
      suspendingHimself: `You can't suspend yourself.`,
      invalidClientIds: 'One or more provided clientIds are invalid for this tenant. ',
      invalidPostSiteIds: 'One or more provided postSiteIds are invalid for this tenant. ',
      revokingOwnPermission: `You can't revoke your own admin permission.`,
      revokingPlanUser: `You can't revoke the admin permission of the plan manager.`,
      destroyingPlanUser: `You can't delete the plan manager.`,
    },
  },

  tenant: {
    exists:
      'There is already a workspace on this application.',
    url: {
      exists: 'This workspace URL is already in use.',
    },
    invitation: {
      notSameEmail: `This invitation was sent to {0} but you're signed in as {1}.`,
    },
    planActive: `There is a plan active for this workspace. Please cancel the plan first.`,
    stripeNotConfigured: 'Stripe is not configured.',
  },

  importer: {
    errors: {
      invalidFileEmpty: 'The file is empty',
      invalidFileExcel:
        'Only excel (.xlsx) files are allowed',
      invalidFileUpload:
        'Invalid file. Make sure you are using the last version of the template.',
      importHashRequired: 'Import hash is required',
      importHashExistent: 'Data has already been imported',
    },
  },

  errors: {
    notFound: {
      message: 'Not Found',
    },
    forbidden: {
      message: 'Forbidden',
    },
    validation: {
      message: 'An error occurred',
    },
  },

  email: {
    error: `Email provider is not configured.`,
  },

  preview: {
    error:
      'Sorry, this operation is not allowed in preview mode.',
  },

  entities: {
    category: {
      errors: {
        inUse: 'Cannot delete category because it is in use by {0} client(s).',
      }
    },
    bannerSuperiorApp: {
      errors: {
        unique: {

        }
      }
    },
    service: {
      errors: {
        unique: {

        }
      }
    },
    certification: {
      errors: {
        unique: {
          code: 'Código de Permiso must be unique',
        }
      }
    },
    securityGuard: {
      errors: {
        unique: {
        },
        notFound: 'No security guard found with the provided ID.',
        mustBeArchivedBeforeDelete: 'The guard must be archived before it can be deleted.',
        noTenantUser: 'No tenant-user relationship found for the guard user.',
        guardOccupiedByGuardShift: 'The guard has active guardShift records and cannot be archived/deleted.',
        guardOccupiedByShift: 'The guard has active shifts and cannot be archived/deleted.',
        guardOccupiedByPatrol: 'The guard is assigned to pending patrols and cannot be archived/deleted.',
        validation: {
          governmentIdTooLong: 'Government ID is too long (max 50 characters)',
          guardCredentialsTooLong: 'Guard credentials are too long (max 255 characters)',
          mustBeAdult: 'The guard must be an adult (18 years or older)',
        }
      }
    },
    clientAccount: {
      errors: {
        unique: {

        },
        exists: 'Ya existe un cliente con este correo electrónico o número de teléfono.'
      }
    },
    representanteEmpresa: {
      errors: {
        unique: {

        }
      }
    },
    incident: {
      errors: {
        unique: {

        }
      }
    },
    inventory: {
      errors: {
        unique: {
          radioSerialNumber: 'No de Serie del Radio must be unique',
          gunSerialNumber: 'Número de Serie de la Arma must be unique',
          armorSerialNumber: 'Número de Serie de Chaleco Antibalas must be unique',
        }
      }
    },
    additionalService: {
      errors: {
        unique: {
          dvrSerialCode: 'No de Serie must be unique',
        }
      }
    },
    patrolCheckpoint: {
      errors: {
        unique: {

        }
      }
    },
    patrolLog: {
      errors: {
        unique: {

        }
      }
    },
    patrol: {
      errors: {
        unique: {

        }
      }
    },
    station: {
      errors: {
        unique: {

        }
      }
    },
    billing: {
      errors: {
        unique: {
          invoiceNumber: 'Número de Factura must be unique',
        }
      }
    },
    inquiries: {
      errors: {
        unique: {

        }
      }
    },
    task: {
      errors: {
        unique: {

        }
      }
    },
    notification: {
      errors: {
        unique: {

        }
      }
    },
    deviceIdInformation: {
      errors: {
        unique: {

        }
      }
    },
    guardShift: {
      errors: {
        unique: {

        }
      }
    },
    memos: {
      errors: {
        unique: {

        }
      }
    },
    request: {
      errors: {
        unique: {

        }
      }
    },
    videoTutorialCategory: {
      errors: {
        unique: {

        }
      }
    },
    videoTutorial: {
      errors: {
        unique: {

        }
      }
    },
    tutorial: {
      errors: {
        unique: {

        }
      }
    },
    completionOfTutorial: {
      errors: {
        unique: {

        }
      }
    },
    inventoryHistory: {
      errors: {
        unique: {

        }
      }
    },
    businessInfo: {
      errors: {
        unique: {

        }
      }
    },
    insurance: {
      errors: {
        unique: {

        }
      }
    },
    notificationRecipient: {
      errors: {
        unique: {

        }
      }
    },
    report: {
      errors: {
        unique: {

        }
      }
    },
    shift: {
      errors: {
        unique: {

        }
      }
    },
  }
};

export default en;
