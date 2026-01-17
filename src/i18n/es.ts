const es = {
  app: {
    title: 'Aplicación',
  },
  auth: {
    userNotFound:
      'El correo no está registrado.',
    wrongPassword:
      'La contraseña es incorrecta.',
    emailNotVerified:
      'Correo no verificado. Revisa tu email.',
    weakPassword: 'Esta contraseña es muy débil.',
    emailAlreadyInUse: 'Correo electrónico ya está en uso por otro usuario.',
    invalidEmail:
      'Por favor proporcione un correo electrónico válido',
    passwordReset: {
      invalidToken:
        'El enlace de restablecimiento de contraseña no es válido o ha expirado',
      error: 'El correo no consta en la base. Intenta nuevamente',
    },
    emailAddressVerificationEmail: {
      invalidToken:
        'El enlace de verificación de correo electrónico no es válido o ha expirado.',
      error: 'Correo electrónico no reconocido',
      signedInAsWrongUser:
        'Esta confirmación por correo electrónico se envió a {0} pero ha iniciado sesión como {1}.',
    },
    passwordChange: {
      invalidPassword:
        'La contraseña anterior no es válida.',
    },
  },
  user: {
    errors: {
      userAlreadyExists:
        'El usuario con este correo electrónico ya existe.',
      userNotFound: 'Usuario no encontrado.',
      destroyingHimself: 'No puedes eliminarte a ti mismo.',
      suspendingHimself: 'No puedes suspenderte a ti mismo.',
      invalidClientIds: 'Uno o más clientIds proporcionados son inválidos para este tenant.',
      invalidPostSiteIds: 'Uno o más postSiteIds proporcionados son inválidos para este tenant.',
      revokingOwnPermission:
        'No puede revocar su propio permiso de administrador.',
      revokingPlanUser:
        'No puede revocar el permiso de administrador del administrador del plan.',
      destroyingPlanUser:
        'No puede eliminar el administrador del plan.',
    },
  },
  tenant: {
    exists:
      'Ya hay un espacio de trabajo en esta aplicación.',
    url: {
      exists:
        'Esta URL del espacio de trabajo ya está en uso.',
      invalid: 'URL inválida. Use solo letras minúsculas, números y guiones (ej. empresa-slug).',
    },
    invitation: {
      notSameEmail:
        'Esta invitación se envió a {0} pero has iniciado sesión como {1}.',
    },
    planActive:
      'Hay un plan activo para este espacio de trabajo. Por favor, cancele el plan primero.',
    stripeNotConfigured: 'Stripe no está configurado.',
  },
  importer: {
    errors: {
      invalidFileEmpty: 'El archivo esta vacio',
      invalidFileExcel:
        'Solo se permiten archivos de Excel(.xlsx)',
      invalidFileUpload:
        'Archivo inválido. Asegúrese de estar utilizando la última versión de la plantilla.',
      importHashRequired: 'Se requiere hash de importación',
      importHashExistent:
        'Los datos ya han sido importados',
    },
  },
  errors: {
    notFound: {
      message: 'Extraviado',
    },
    forbidden: {
      message: 'Prohibido',
    },
    validation: {
      message: 'Ocurrió un error',
      duplicate: 'Ya existe ese elemento',
      tokenExpired: 'La sesión expiró. Por favor inicia sesión de nuevo.',
    },
  },
  email: {
    error:
      'El proveedor de correo electrónico no está configurado.',
  },
  preview: {
    error:
      'Lo sentimos, esta operación no está permitida en el modo de vista previa.',
  },

  entities: {
    category: {
      errors: {
        inUse: 'No se puede eliminar la categoría porque está en uso por {0} cliente(s).',
      }
    },
    role: {
      errors: {
        inUse: 'No se puede eliminar el rol porque está en uso.',
      }
    },
    tax: {
      errors: {
        exists: 'Ya existe un impuesto con este nombre.'
      }
    },
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
        code: 'Código de Permiso debe ser único',
      }
    }
  },
  securityGuard: {
    errors: {
      unique: {
      },
      notFound: 'No se encontró un guardia con el ID proporcionado.',
      mustBeArchivedBeforeDelete: 'El guardia debe ser archivado antes de poder eliminarlo.',
      noTenantUser: 'No se encontró relación de tenant con el usuario del guardia.',
      guardOccupiedByGuardShift: 'El guardia tiene guardias activas (guardShift) y no puede ser archivado/eliminado.',
      guardOccupiedByShift: 'El guardia tiene turnos activos y no puede ser archivado/eliminado.',
      guardOccupiedByPatrol: 'El guardia está asignado a patrullas pendientes y no puede ser archivado/eliminado.',
      validation: {
        governmentIdTooLong: 'El número de identificación es demasiado largo (máx 50 caracteres)',
        guardCredentialsTooLong: 'Las credenciales del guardia son demasiado largas (máx 255 caracteres)',
        mustBeAdult: 'El guardia debe ser mayor de edad (18 años o más)',
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
        radioSerialNumber: 'No de Serie del Radio debe ser único',
        gunSerialNumber: 'Número de Serie de la Arma debe ser único',
        armorSerialNumber: 'Número de Serie de Chaleco Antibalas debe ser único',
      }
    }
  },
  additionalService: {
    errors: {
      unique: {
        dvrSerialCode: 'No de Serie debe ser único',
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
        invoiceNumber: 'Número de Factura debe ser único',
      }
    }
  },
  invoice: {
    errors: {
      notFullyPaid: 'Complete el pago para enviar la factura',
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
};

export default es;
