import Roles from './roles';
import Plans from './plans';
import Storage from './storage';

const storage = Storage.values;
const roles = Roles.values;
const plans = Plans.values;

// Role groups for easier permission management
const ADMIN_ROLES = [roles.admin];
const MANAGEMENT_ROLES = [roles.admin, roles.operationsManager];
const SUPERVISOR_ROLES = [roles.admin, roles.operationsManager, roles.securitySupervisor];
const HR_ROLES = [roles.admin, roles.operationsManager, roles.hrManager];
const CLIENT_MANAGEMENT_ROLES = [roles.admin, roles.operationsManager, roles.clientAccountManager];
const DISPATCHER_ROLES = [roles.admin, roles.operationsManager, roles.securitySupervisor, roles.dispatcher];
const GUARD_ROLES = [roles.admin, roles.operationsManager, roles.securitySupervisor, roles.dispatcher, roles.securityGuard];
const ALL_STAFF_ROLES = [roles.admin, roles.operationsManager, roles.securitySupervisor, roles.clientAccountManager, roles.hrManager, roles.dispatcher, roles.securityGuard];
const ALL_ROLES = [...ALL_STAFF_ROLES, roles.customer, roles.custom];

// Helper function to create permission with all required properties
const createPermission = (id: string, allowedRoles: string[], allowedPlans: string[] = [plans.free, plans.growth, plans.enterprise], allowedStorage: any[] = []) => ({
  id,
  allowedRoles,
  allowedPlans,
  allowedStorage,
});

class Permissions {
  static get values() {
    return {
      // === SYSTEM ADMINISTRATION ===
      tenantEdit: createPermission('tenantEdit', ADMIN_ROLES),
      tenantDestroy: createPermission('tenantDestroy', ADMIN_ROLES),
      planEdit: createPermission('planEdit', ADMIN_ROLES),
      planRead: createPermission('planRead', ADMIN_ROLES),

      // === USER MANAGEMENT ===
      userEdit: createPermission('userEdit', HR_ROLES),
      userDestroy: createPermission('userDestroy', HR_ROLES),
      userCreate: createPermission('userCreate', HR_ROLES),
      userImport: createPermission('userImport', HR_ROLES),
      userRead: createPermission('userRead', ALL_STAFF_ROLES),
      userAutocomplete: createPermission('userAutocomplete', ALL_STAFF_ROLES),

      // === AUDIT LOGS ===
      auditLogRead: createPermission('auditLogRead', MANAGEMENT_ROLES),

      // === SETTINGS ===
      settingsEdit: createPermission('settingsEdit', ADMIN_ROLES, [plans.free, plans.growth, plans.enterprise], [storage.settingsBackgroundImages, storage.settingsLogos]),
      settingsRead: createPermission('settingsRead', ALL_STAFF_ROLES),

      // === BANNER/ANNOUNCEMENTS ===
      bannerSuperiorAppImport: createPermission('bannerSuperiorAppImport', MANAGEMENT_ROLES),
      bannerSuperiorAppCreate: createPermission('bannerSuperiorAppCreate', MANAGEMENT_ROLES),
      bannerSuperiorAppEdit: createPermission('bannerSuperiorAppEdit', MANAGEMENT_ROLES),
      bannerSuperiorAppDestroy: createPermission('bannerSuperiorAppDestroy', MANAGEMENT_ROLES),
      bannerSuperiorAppRead: createPermission('bannerSuperiorAppRead', ALL_STAFF_ROLES),
      bannerSuperiorAppAutocomplete: createPermission('bannerSuperiorAppAutocomplete', ALL_STAFF_ROLES),

      // === SERVICES ===
      serviceImport: createPermission('serviceImport', CLIENT_MANAGEMENT_ROLES),
      serviceCreate: createPermission('serviceCreate', CLIENT_MANAGEMENT_ROLES),
      serviceEdit: createPermission('serviceEdit', CLIENT_MANAGEMENT_ROLES),
      serviceDestroy: createPermission('serviceDestroy', CLIENT_MANAGEMENT_ROLES),
      serviceRead: createPermission('serviceRead', ALL_STAFF_ROLES),
      serviceAutocomplete: createPermission('serviceAutocomplete', ALL_STAFF_ROLES),

      // === CERTIFICATIONS ===
      certificationImport: createPermission('certificationImport', HR_ROLES),
      certificationCreate: createPermission('certificationCreate', HR_ROLES),
      certificationEdit: createPermission('certificationEdit', HR_ROLES),
      certificationDestroy: createPermission('certificationDestroy', HR_ROLES),
      certificationRead: createPermission('certificationRead', ALL_STAFF_ROLES),
      certificationAutocomplete: createPermission('certificationAutocomplete', ALL_STAFF_ROLES),

      // === SECURITY GUARD MANAGEMENT ===
      securityGuardImport: createPermission('securityGuardImport', HR_ROLES),
      securityGuardCreate: createPermission('securityGuardCreate', HR_ROLES),
      securityGuardEdit: createPermission('securityGuardEdit', [...SUPERVISOR_ROLES, roles.hrManager]),
      securityGuardDestroy: createPermission('securityGuardDestroy', HR_ROLES),
      securityGuardRead: createPermission('securityGuardRead', ALL_STAFF_ROLES),
      securityGuardAutocomplete: createPermission('securityGuardAutocomplete', ALL_STAFF_ROLES),

      // === CLIENT ACCOUNTS ===
      clientAccountImport: createPermission('clientAccountImport', CLIENT_MANAGEMENT_ROLES),
      clientAccountCreate: createPermission('clientAccountCreate', CLIENT_MANAGEMENT_ROLES),
      clientAccountEdit: createPermission('clientAccountEdit', CLIENT_MANAGEMENT_ROLES),
      clientAccountDestroy: createPermission('clientAccountDestroy', CLIENT_MANAGEMENT_ROLES),
      clientAccountRead: createPermission('clientAccountRead', [...ALL_STAFF_ROLES, roles.customer]),
      clientAccountAutocomplete: createPermission('clientAccountAutocomplete', ALL_STAFF_ROLES),

      // === BUSINESS INFO ===
      businessInfoImport: createPermission('businessInfoImport', MANAGEMENT_ROLES),
      businessInfoCreate: createPermission('businessInfoCreate', MANAGEMENT_ROLES),
      businessInfoEdit: createPermission('businessInfoEdit', MANAGEMENT_ROLES),
      businessInfoDestroy: createPermission('businessInfoDestroy', ADMIN_ROLES),
      businessInfoRead: createPermission('businessInfoRead', ALL_STAFF_ROLES),
      businessInfoAutocomplete: createPermission('businessInfoAutocomplete', ALL_STAFF_ROLES),

      // === COMPANY REPRESENTATIVES ===
      representanteEmpresaImport: createPermission('representanteEmpresaImport', CLIENT_MANAGEMENT_ROLES),
      representanteEmpresaCreate: createPermission('representanteEmpresaCreate', CLIENT_MANAGEMENT_ROLES),
      representanteEmpresaEdit: createPermission('representanteEmpresaEdit', CLIENT_MANAGEMENT_ROLES),
      representanteEmpresaDestroy: createPermission('representanteEmpresaDestroy', CLIENT_MANAGEMENT_ROLES),
      representanteEmpresaRead: createPermission('representanteEmpresaRead', ALL_STAFF_ROLES),
      representanteEmpresaAutocomplete: createPermission('representanteEmpresaAutocomplete', ALL_STAFF_ROLES),

      // === INCIDENTS ===
      incidentImport: createPermission('incidentImport', SUPERVISOR_ROLES),
      incidentCreate: createPermission('incidentCreate', GUARD_ROLES),
      incidentEdit: createPermission('incidentEdit', SUPERVISOR_ROLES),
      incidentDestroy: createPermission('incidentDestroy', SUPERVISOR_ROLES),
      incidentRead: createPermission('incidentRead', [...ALL_STAFF_ROLES, roles.customer]),
      incidentAutocomplete: createPermission('incidentAutocomplete', ALL_STAFF_ROLES),

      // === STATIONS ===
      stationImport: createPermission('stationImport', MANAGEMENT_ROLES),
      stationCreate: createPermission('stationCreate', MANAGEMENT_ROLES),
      stationEdit: createPermission('stationEdit', SUPERVISOR_ROLES),
      stationDestroy: createPermission('stationDestroy', MANAGEMENT_ROLES),
      stationRead: createPermission('stationRead', [...ALL_STAFF_ROLES, roles.customer]),
      stationAutocomplete: createPermission('stationAutocomplete', ALL_STAFF_ROLES),

      // === SHIFTS & SCHEDULING ===
      shiftImport: createPermission('shiftImport', DISPATCHER_ROLES),
      shiftCreate: createPermission('shiftCreate', DISPATCHER_ROLES),
      shiftEdit: createPermission('shiftEdit', DISPATCHER_ROLES),
      shiftDestroy: createPermission('shiftDestroy', DISPATCHER_ROLES),
      shiftRead: createPermission('shiftRead', ALL_STAFF_ROLES),
      shiftAutocomplete: createPermission('shiftAutocomplete', ALL_STAFF_ROLES),

      // === GUARD SHIFTS ===
      guardShiftImport: createPermission('guardShiftImport', DISPATCHER_ROLES),
      guardShiftCreate: createPermission('guardShiftCreate', DISPATCHER_ROLES),
      guardShiftEdit: createPermission('guardShiftEdit', DISPATCHER_ROLES),
      guardShiftDestroy: createPermission('guardShiftDestroy', DISPATCHER_ROLES),
      guardShiftRead: createPermission('guardShiftRead', ALL_STAFF_ROLES),
      guardShiftAutocomplete: createPermission('guardShiftAutocomplete', ALL_STAFF_ROLES),

      // === PATROLS ===
      patrolImport: createPermission('patrolImport', SUPERVISOR_ROLES),
      patrolCreate: createPermission('patrolCreate', GUARD_ROLES),
      patrolEdit: createPermission('patrolEdit', SUPERVISOR_ROLES),
      patrolDestroy: createPermission('patrolDestroy', SUPERVISOR_ROLES),
      patrolRead: createPermission('patrolRead', [...ALL_STAFF_ROLES, roles.customer]),
      patrolAutocomplete: createPermission('patrolAutocomplete', ALL_STAFF_ROLES),

      // === PATROL CHECKPOINTS ===
      patrolCheckpointImport: createPermission('patrolCheckpointImport', SUPERVISOR_ROLES),
      patrolCheckpointCreate: createPermission('patrolCheckpointCreate', SUPERVISOR_ROLES),
      patrolCheckpointEdit: createPermission('patrolCheckpointEdit', SUPERVISOR_ROLES),
      patrolCheckpointDestroy: createPermission('patrolCheckpointDestroy', SUPERVISOR_ROLES),
      patrolCheckpointRead: createPermission('patrolCheckpointRead', ALL_STAFF_ROLES),
      patrolCheckpointAutocomplete: createPermission('patrolCheckpointAutocomplete', ALL_STAFF_ROLES),

      // === PATROL LOGS ===
      patrolLogImport: createPermission('patrolLogImport', SUPERVISOR_ROLES),
      patrolLogCreate: createPermission('patrolLogCreate', GUARD_ROLES),
      patrolLogEdit: createPermission('patrolLogEdit', SUPERVISOR_ROLES),
      patrolLogDestroy: createPermission('patrolLogDestroy', SUPERVISOR_ROLES),
      patrolLogRead: createPermission('patrolLogRead', [...ALL_STAFF_ROLES, roles.customer]),
      patrolLogAutocomplete: createPermission('patrolLogAutocomplete', ALL_STAFF_ROLES),

      // === REPORTS ===
      reportImport: createPermission('reportImport', SUPERVISOR_ROLES),
      reportCreate: createPermission('reportCreate', GUARD_ROLES),
      reportEdit: createPermission('reportEdit', SUPERVISOR_ROLES),
      reportDestroy: createPermission('reportDestroy', SUPERVISOR_ROLES),
      reportRead: createPermission('reportRead', [...ALL_STAFF_ROLES, roles.customer]),
      reportAutocomplete: createPermission('reportAutocomplete', ALL_STAFF_ROLES),

      // === INVENTORY ===
      inventoryImport: createPermission('inventoryImport', SUPERVISOR_ROLES),
      inventoryCreate: createPermission('inventoryCreate', SUPERVISOR_ROLES),
      inventoryEdit: createPermission('inventoryEdit', SUPERVISOR_ROLES),
      inventoryDestroy: createPermission('inventoryDestroy', SUPERVISOR_ROLES),
      inventoryRead: createPermission('inventoryRead', ALL_STAFF_ROLES),
      inventoryAutocomplete: createPermission('inventoryAutocomplete', ALL_STAFF_ROLES),

      // === INVENTORY HISTORY ===
      inventoryHistoryImport: createPermission('inventoryHistoryImport', SUPERVISOR_ROLES),
      inventoryHistoryCreate: createPermission('inventoryHistoryCreate', GUARD_ROLES),
      inventoryHistoryEdit: createPermission('inventoryHistoryEdit', SUPERVISOR_ROLES),
      inventoryHistoryDestroy: createPermission('inventoryHistoryDestroy', SUPERVISOR_ROLES),
      inventoryHistoryRead: createPermission('inventoryHistoryRead', ALL_STAFF_ROLES),
      inventoryHistoryAutocomplete: createPermission('inventoryHistoryAutocomplete', ALL_STAFF_ROLES),

      // === ADDITIONAL SERVICES ===
      additionalServiceImport: createPermission('additionalServiceImport', CLIENT_MANAGEMENT_ROLES),
      additionalServiceCreate: createPermission('additionalServiceCreate', CLIENT_MANAGEMENT_ROLES),
      additionalServiceEdit: createPermission('additionalServiceEdit', CLIENT_MANAGEMENT_ROLES),
      additionalServiceDestroy: createPermission('additionalServiceDestroy', CLIENT_MANAGEMENT_ROLES),
      additionalServiceRead: createPermission('additionalServiceRead', ALL_STAFF_ROLES),
      additionalServiceAutocomplete: createPermission('additionalServiceAutocomplete', ALL_STAFF_ROLES),

      // === BILLING ===
      billingImport: createPermission('billingImport', MANAGEMENT_ROLES),
      billingCreate: createPermission('billingCreate', MANAGEMENT_ROLES),
      billingEdit: createPermission('billingEdit', MANAGEMENT_ROLES),
      billingDestroy: createPermission('billingDestroy', MANAGEMENT_ROLES),
      billingRead: createPermission('billingRead', [...MANAGEMENT_ROLES, roles.clientAccountManager, roles.customer]),
      billingAutocomplete: createPermission('billingAutocomplete', MANAGEMENT_ROLES),

      // === NOTIFICATIONS ===
      notificationImport: createPermission('notificationImport', MANAGEMENT_ROLES),
      notificationCreate: createPermission('notificationCreate', SUPERVISOR_ROLES),
      notificationEdit: createPermission('notificationEdit', SUPERVISOR_ROLES),
      notificationDestroy: createPermission('notificationDestroy', SUPERVISOR_ROLES),
      notificationRead: createPermission('notificationRead', ALL_STAFF_ROLES),
      notificationAutocomplete: createPermission('notificationAutocomplete', ALL_STAFF_ROLES),

      // === NOTIFICATION RECIPIENTS ===
      notificationRecipientImport: createPermission('notificationRecipientImport', SUPERVISOR_ROLES),
      notificationRecipientCreate: createPermission('notificationRecipientCreate', SUPERVISOR_ROLES),
      notificationRecipientEdit: createPermission('notificationRecipientEdit', SUPERVISOR_ROLES),
      notificationRecipientDestroy: createPermission('notificationRecipientDestroy', SUPERVISOR_ROLES),
      notificationRecipientRead: createPermission('notificationRecipientRead', ALL_STAFF_ROLES),
      notificationRecipientAutocomplete: createPermission('notificationRecipientAutocomplete', ALL_STAFF_ROLES),

      // === INQUIRIES ===
      inquiriesImport: createPermission('inquiriesImport', CLIENT_MANAGEMENT_ROLES),
      inquiriesCreate: createPermission('inquiriesCreate', [...ALL_STAFF_ROLES, roles.customer]),
      inquiriesEdit: createPermission('inquiriesEdit', CLIENT_MANAGEMENT_ROLES),
      inquiriesDestroy: createPermission('inquiriesDestroy', CLIENT_MANAGEMENT_ROLES),
      inquiriesRead: createPermission('inquiriesRead', [...ALL_STAFF_ROLES, roles.customer]),
      inquiriesAutocomplete: createPermission('inquiriesAutocomplete', ALL_STAFF_ROLES),

      // === REQUESTS ===
      requestImport: createPermission('requestImport', CLIENT_MANAGEMENT_ROLES),
      requestCreate: createPermission('requestCreate', [...ALL_STAFF_ROLES, roles.customer]),
      requestEdit: createPermission('requestEdit', CLIENT_MANAGEMENT_ROLES),
      requestDestroy: createPermission('requestDestroy', CLIENT_MANAGEMENT_ROLES),
      requestRead: createPermission('requestRead', [...ALL_STAFF_ROLES, roles.customer]),
      requestAutocomplete: createPermission('requestAutocomplete', ALL_STAFF_ROLES),

      // === TASKS ===
      taskImport: createPermission('taskImport', SUPERVISOR_ROLES),
      taskCreate: createPermission('taskCreate', SUPERVISOR_ROLES),
      taskEdit: createPermission('taskEdit', SUPERVISOR_ROLES),
      taskDestroy: createPermission('taskDestroy', SUPERVISOR_ROLES),
      taskRead: createPermission('taskRead', ALL_STAFF_ROLES),
      taskAutocomplete: createPermission('taskAutocomplete', ALL_STAFF_ROLES),

      // === MEMOS ===
      memosImport: createPermission('memosImport', SUPERVISOR_ROLES),
      memosCreate: createPermission('memosCreate', SUPERVISOR_ROLES),
      memosEdit: createPermission('memosEdit', SUPERVISOR_ROLES),
      memosDestroy: createPermission('memosDestroy', SUPERVISOR_ROLES),
      memosRead: createPermission('memosRead', ALL_STAFF_ROLES),
      memosAutocomplete: createPermission('memosAutocomplete', ALL_STAFF_ROLES),

      // === TUTORIALS & TRAINING ===
      tutorialImport: createPermission('tutorialImport', HR_ROLES),
      tutorialCreate: createPermission('tutorialCreate', HR_ROLES),
      tutorialEdit: createPermission('tutorialEdit', HR_ROLES),
      tutorialDestroy: createPermission('tutorialDestroy', HR_ROLES),
      tutorialRead: createPermission('tutorialRead', ALL_STAFF_ROLES),
      tutorialAutocomplete: createPermission('tutorialAutocomplete', ALL_STAFF_ROLES),

      // === VIDEO TUTORIALS ===
      videoTutorialImport: createPermission('videoTutorialImport', HR_ROLES),
      videoTutorialCreate: createPermission('videoTutorialCreate', HR_ROLES),
      videoTutorialEdit: createPermission('videoTutorialEdit', HR_ROLES),
      videoTutorialDestroy: createPermission('videoTutorialDestroy', HR_ROLES),
      videoTutorialRead: createPermission('videoTutorialRead', ALL_STAFF_ROLES),
      videoTutorialAutocomplete: createPermission('videoTutorialAutocomplete', ALL_STAFF_ROLES),

      // === VIDEO TUTORIAL CATEGORIES ===
      videoTutorialCategoryImport: createPermission('videoTutorialCategoryImport', HR_ROLES),
      videoTutorialCategoryCreate: createPermission('videoTutorialCategoryCreate', HR_ROLES),
      videoTutorialCategoryEdit: createPermission('videoTutorialCategoryEdit', HR_ROLES),
      videoTutorialCategoryDestroy: createPermission('videoTutorialCategoryDestroy', HR_ROLES),
      videoTutorialCategoryRead: createPermission('videoTutorialCategoryRead', ALL_STAFF_ROLES),
      videoTutorialCategoryAutocomplete: createPermission('videoTutorialCategoryAutocomplete', ALL_STAFF_ROLES),

      // === COMPLETION OF TUTORIAL ===
      completionOfTutorialImport: createPermission('completionOfTutorialImport', HR_ROLES),
      completionOfTutorialCreate: createPermission('completionOfTutorialCreate', [...HR_ROLES, ...GUARD_ROLES]),
      completionOfTutorialEdit: createPermission('completionOfTutorialEdit', HR_ROLES),
      completionOfTutorialDestroy: createPermission('completionOfTutorialDestroy', HR_ROLES),
      completionOfTutorialRead: createPermission('completionOfTutorialRead', ALL_STAFF_ROLES),
      completionOfTutorialAutocomplete: createPermission('completionOfTutorialAutocomplete', ALL_STAFF_ROLES),

      // === DEVICE ID INFORMATION ===
      deviceIdInformationImport: createPermission('deviceIdInformationImport', ADMIN_ROLES),
      deviceIdInformationCreate: createPermission('deviceIdInformationCreate', ALL_STAFF_ROLES),
      deviceIdInformationEdit: createPermission('deviceIdInformationEdit', ADMIN_ROLES),
      deviceIdInformationDestroy: createPermission('deviceIdInformationDestroy', ADMIN_ROLES),
      deviceIdInformationRead: createPermission('deviceIdInformationRead', MANAGEMENT_ROLES),
      deviceIdInformationAutocomplete: createPermission('deviceIdInformationAutocomplete', MANAGEMENT_ROLES),

      // === INSURANCE ===
      insuranceImport: createPermission('insuranceImport', MANAGEMENT_ROLES),
      insuranceCreate: createPermission('insuranceCreate', MANAGEMENT_ROLES),
      insuranceEdit: createPermission('insuranceEdit', MANAGEMENT_ROLES),
      insuranceDestroy: createPermission('insuranceDestroy', MANAGEMENT_ROLES),
      insuranceRead: createPermission('insuranceRead', ALL_STAFF_ROLES),
      insuranceAutocomplete: createPermission('insuranceAutocomplete', ALL_STAFF_ROLES),

      // === FILE STORAGE ===
      fileCreate: createPermission('fileCreate', ALL_STAFF_ROLES, [plans.free, plans.growth, plans.enterprise], Object.values(storage)),
      fileEdit: createPermission('fileEdit', ALL_STAFF_ROLES, [plans.free, plans.growth, plans.enterprise], Object.values(storage)),
      fileDestroy: createPermission('fileDestroy', ALL_STAFF_ROLES, [plans.free, plans.growth, plans.enterprise], Object.values(storage)),
      fileRead: createPermission('fileRead', ALL_STAFF_ROLES, [plans.free, plans.growth, plans.enterprise], Object.values(storage)),
    };
  }

  static get asArray() {
    return Object.values(this.values);
  }
}

export default Permissions;