/**
 * I18n dictionary for the en.
 */

const ptBR = {
  app: {
    title: 'Aplicação',
  },
    role: {
      errors: {
        inUse: 'Não é possível excluir a função porque está em uso por {0} usuário(s).',
      }
    },
    tax: {
      errors: {
        exists: 'Já existe um imposto com este nome para este workspace.'
      }
    },

  auth: {
    userNotFound: 'O e-mail não está cadastrado.',
    wrongPassword: 'A senha está incorreta.',
    emailNotVerified: 'E-mail não verificado. Verifique sua caixa de entrada.',
    weakPassword: 'Esta senha é muito fraca',
    emailAlreadyInUse: 'O email já está sendo usado',
    invalidEmail: 'Por favor forneça um email válido',
    passwordReset: {
      invalidToken:
        'Link de redefinição de senha inválido ou expirado',
      error: `Email não encontrado`,
    },
    emailAddressVerificationEmail: {
      invalidToken:
        'Link de verificação de email inválido ou expirado.',
      error: `Email não encontrado.`,
      signedInAsWrongUser: `Esta confirmação de email foi enviada para {0} mas você está acessando como {1}.`,
    },
    passwordChange: {
      invalidPassword: 'A senha antiga é inválida',
    },
  },

  user: {
    errors: {
      userAlreadyExists: 'Usuário com este email já existe',
      userNotFound: 'Usuário não encontrado',
      destroyingHimself: `Você não pode deletar-se`,
      suspendingHimself: `Você não pode se suspender.`,
      invalidClientIds: 'Um ou mais clientIds fornecidos são inválidos para este tenant.',
      invalidPostSiteIds: 'Um ou mais postSiteIds fornecidos são inválidos para este tenant.',
      revokingOwnPermission: `Você não pode revogar sua própria permissão de proprietário`,
      revokingPlanUser: `Você não pode revogar a permissão do responsável pelo plano ativo`,
      destroyingPlanUser: `Você não pode deletar o responsável pelo plano ativo`,
      passwordRequired: 'A senha é obrigatória.',
      cannotUseOldPasswordForOtherUser: 'Você não pode usar a senha antiga para alterar a senha de outro usuário.',
    },
  },

  tenant: {
    exists: 'Já existe um inquilino para esta aplicação.',
    url: {
      exists:
        'Esta URL de área de trabalho já está em uso.',
      invalid: 'URL inválida. Use apenas letras minúsculas, números e hifens (ex.: minha-empresa).',
    },
    invitation: {
      notSameEmail: `Este convite foi enviado para {0} mas você está acessando como {1}.`,
    },
    planActive: `Existe um plano ativo para esta área de trabalho. Por favor primeiro cancele o plano.`,
  },

  importer: {
    errors: {
      invalidFileEmpty: 'O arquivo está vazio',
      invalidFileExcel:
        'Apenas arquivos Excel (.xlsx) são permitidos',
      invalidFileUpload:
        'Arquivo inválido. Verifique se você está usando a última versão do modelo.',
      importHashRequired: 'Hash de importação é necessário',
      importHashExistent: 'Dados já foram importados',
    },
  },

  errors: {
    notFound: {
      message: 'Não encontrado',
    },
    forbidden: {
      message: 'Não permitido',
    },
    validation: {
      message: 'Ocorreu um erro',
      duplicate: 'Este item já existe',
      tokenExpired: 'Sessão expirada. Por favor, entre novamente.',
    },
  },

  email: {
    error: `Email não configurado.`,
  },

  preview: {
    error:
      'Desculpe, esta operação não é permitida em modo de demonstração.',
  },

  entities: {
    category: {
      errors: {
        inUse: 'Não é possível excluir a categoria porque está em uso por {0} cliente(s).',
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
          code: 'Código de Permiso deve ser único',
        }
      }
    },
    securityGuard: {
      errors: {
        unique: {

        }
      }
    },
    clientAccount: {
      errors: {
        unique: {

        },
        exists: 'Já existe um cliente com este e-mail ou número de telefone.'
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
          radioSerialNumber: 'No de Serie del Radio deve ser único',
          gunSerialNumber: 'Número de Serie de la Arma deve ser único',
          armorSerialNumber: 'Número de Serie de Chaleco Antibalas deve ser único',
        }
      }
    },
    additionalService: {
      errors: {
        unique: {
          dvrSerialCode: 'No de Serie deve ser único',
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
          invoiceNumber: 'Número de Factura deve ser único',
        }
      }
    },
    invoice: {
      errors: {
        notFullyPaid: 'Complete o pagamento antes de enviar a fatura',
        cannotModifySentPaid: 'Uma fatura enviada e paga não pode ser modificada ou excluída',
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

export default ptBR;
