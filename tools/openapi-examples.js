/**
 * Domain-aware examples for OpenAPI spec generation.
 * Used by generate-openapi.js to produce realistic request/response examples.
 */

// ─── Field-level example values (used for auto-generated schemas) ────────────
const fieldExamples = {
  // IDs
  id: '550e8400-e29b-41d4-a716-446655440000',
  tenantId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
  clientId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  clientAccountId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  guardNameId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  userId: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
  tenantUserId: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
  assignmentId: 'b1c2d3e4-f5a6-7890-bcde-f12345678901',
  contactId: 'd4e5f6a7-b8c9-0123-4567-89abcdef0123',
  noteId: 'e5f6a7b8-c9d0-1234-5678-9abcdef01234',
  conversationId: 'f6a7b8c9-d012-3456-789a-bcdef0123456',
  importHash: 'abc123def456',

  // Personal info
  email: 'carlos.mendez@empresa.com',
  password: 'SecurePass123!',
  firstName: 'Carlos',
  lastName: 'Mendez',
  fullName: 'Carlos Mendez',
  name: 'Seguridad Elite S.A.',
  companyName: 'Corporación Nacional de Telecomunicaciones',
  callerName: 'María García',

  // Contact
  phoneNumber: '+593987654321',
  phone: '+593987654321',
  contactPhone: '+593-2-2345678',
  contactEmail: 'contacto@empresa.com',
  faxNumber: '+593-2-2345679',
  landline: '+593-2-2345678',
  website: 'https://www.empresa.com',

  // Address
  address: 'Av. 6 de Diciembre N33-44 y Eloy Alfaro',
  addressComplement: 'Edificio Torre Sol, Piso 5',
  addressLine2: 'Oficina 501',
  secondAddress: 'Esquina con Av. Amazonas',
  zipCode: '170102',
  postalCode: '170102',
  city: 'Quito',
  country: 'Ecuador',
  location: 'Edificio Torres del Norte, Lobby Principal',
  punchInAddress: 'Av. República y Pradera, Quito',

  // Geolocation
  latitude: -0.180653,
  longitude: -78.467834,
  latitud: -0.180653,
  longitud: -78.467834,
  punchInLatitude: -0.180653,
  punchInLongitude: -78.467834,
  punchOutLatitude: -0.180221,
  punchOutLongitude: -78.467912,

  // Dates / Times
  date: '2026-06-07',
  dueDate: '2026-07-07',
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  dateTime: '2026-06-07T08:00:00.000Z',
  incidentAt: '2026-06-07T14:35:00.000Z',
  punchInTime: '2026-06-07T07:55:00.000Z',
  punchOutTime: '2026-06-07T19:05:00.000Z',
  scheduledEnd: '2026-06-07T19:00:00.000Z',
  scheduledTime: '2026-06-07T22:00:00.000Z',
  completionTime: '2026-06-07T22:45:00.000Z',
  startAt: '2026-06-07T07:00:00.000Z',
  endAt: '2026-06-07T19:00:00.000Z',
  startingTimeInDay: '07:00',
  finishTimeInDay: '19:00',
  birthDate: '1990-05-15',

  // Guard specific
  governmentId: '1712345678',
  identificationNumber: '1712345678',
  gender: 'Masculino',
  bloodType: 'O+',
  maritalStatus: 'Casado',
  academicInstruction: 'Universitaria',
  guardCredentials: 'Licencia COSP-2025-4521',
  birthPlace: 'Guayaquil',
  shiftSchedule: 'Diurno',
  observations: 'Turno sin novedades. Perímetro asegurado.',

  // Station
  stationName: 'Puesto Norte - Entrada Principal',
  nickname: 'Norte-1',
  numberOfGuardsInStation: '3',
  stationSchedule: '24/7',
  geofenceRadius: 100,
  scheduleType: '12h-day',

  // Incident
  title: 'Intento de ingreso no autorizado',
  subject: 'Seguridad perimetral',
  description: 'Se detectó una persona intentando ingresar por la puerta lateral sin credenciales de acceso.',
  content: 'El guardia de turno interceptó al individuo y verificó su identidad.',
  action: 'Se notificó al supervisor y se registró en bitácora.',
  priority: 'alta',
  status: 'abierto',
  callerType: 'Guardia',
  internalNotes: 'Revisar cámaras del sector B.',
  actionsTaken: 'Se alertó a patrulla móvil y se reforzó vigilancia.',

  // Invoice / Billing
  invoiceNumber: 'FAC-2026-000142',
  poSoNumber: 'OC-2026-0089',
  subtotal: 2500.00,
  total: 2800.00,
  rate: 12.50,
  quantity: 160,
  taxRate: 12,
  chargeRate: 15.00,
  payRate: 8.50,
  notes: 'Servicio de guardianía mes de junio 2026.',
  summary: 'Factura por servicios de seguridad - Junio 2026',

  // Post site / Service
  serviceType: 'manned',
  active: true,
  completed: false,
  wasRead: false,

  // Battery / Device
  battery: 85,
  punchInBattery: 92,

  // Misc
  token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  invitationToken: 'inv_abc123def456',
  input: 'Av. 6 de Diciembre',
  language: 'es',
  message: 'Turno asignado correctamente.',
  reason: 'Cita médica programada.',
};

// ─── Route-specific request examples ─────────────────────────────────────────
const routeExamples = {
  'POST /auth/sign-in': {
    request: {
      email: 'carlos.mendez@empresa.com',
      password: 'SecurePass123!',
    },
    response: {
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCIsImVtYWlsIjoiY2FybG9zQGVtcHJlc2EuY29tIiwiaWF0IjoxNzE3Nzk5MjAwfQ.signature',
      user: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'carlos.mendez@empresa.com',
        fullName: 'Carlos Mendez',
        avatarUrl: null,
      },
      tenants: [
        {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          name: 'Seguridad Elite S.A.',
          roles: ['admin'],
        },
      ],
    },
  },
  'POST /auth/sign-up': {
    request: {
      email: 'nuevo.guardia@empresa.com',
      password: 'NuevoGuardia2026!',
    },
  },
  'PUT /auth/change-password': {
    request: {
      oldPassword: 'OldPass123!',
      newPassword: 'NewSecure2026!',
    },
  },
  'PUT /auth/password-reset': {
    request: {
      token: 'reset_token_abc123',
      password: 'NewPassword2026!',
    },
  },
  'POST /auth/send-password-reset-email': {
    request: { email: 'carlos.mendez@empresa.com' },
  },
  'POST /auth/send-email-address-verification-email': {
    request: { email: 'carlos.mendez@empresa.com' },
  },
  'PUT /auth/verify-email': {
    request: { token: 'verify_token_xyz789' },
  },
  'PUT /auth/profile': {
    request: {
      firstName: 'Carlos',
      lastName: 'Mendez',
      phoneNumber: '+593987654321',
      avatars: [],
    },
  },

  // Client Accounts
  'POST /tenant/{tenantId}/client-account': {
    request: {
      name: 'Corporación Nacional de Telecomunicaciones',
      email: 'seguridad@cnt.gob.ec',
      phoneNumber: '+593-2-2900100',
      address: 'Av. Japón N35-55 y Naciones Unidas',
      city: 'Quito',
      country: 'Ecuador',
      zipCode: '170507',
      active: true,
    },
    response: {
      id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      name: 'Corporación Nacional de Telecomunicaciones',
      email: 'seguridad@cnt.gob.ec',
      phoneNumber: '+593-2-2900100',
      address: 'Av. Japón N35-55 y Naciones Unidas',
      city: 'Quito',
      country: 'Ecuador',
      active: true,
      createdAt: '2026-06-07T10:00:00.000Z',
    },
  },

  // Post Sites
  'POST /tenant/{tenantId}/post-site': {
    request: {
      companyName: 'Centro Comercial Quicentro Norte',
      address: 'Av. Naciones Unidas E2-30 y Av. 6 de Diciembre',
      city: 'Quito',
      country: 'Ecuador',
      contactPhone: '+593-2-2469820',
      contactEmail: 'seguridad@quicentro.com',
      latitud: -0.176089,
      longitud: -78.480148,
      serviceType: 'manned',
      active: true,
    },
  },

  // Stations
  'POST /tenant/{tenantId}/station': {
    request: {
      stationName: 'Puesto Norte - Entrada Principal',
      nickname: 'Norte-1',
      latitud: -0.176089,
      longitud: -78.480148,
      numberOfGuardsInStation: '2',
      startingTimeInDay: '07:00',
      finishTimeInDay: '19:00',
      geofenceRadius: 100,
      scheduleType: '12h-day',
      postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    },
  },

  // Security Guards
  'POST /tenant/{tenantId}/security-guard': {
    request: {
      firstName: 'Carlos',
      lastName: 'Mendez',
      contact: 'carlos.mendez@empresa.com',
      governmentId: '1712345678',
      gender: 'Masculino',
      bloodType: 'O+',
      birthDate: '1990-05-15',
      birthPlace: 'Guayaquil',
      maritalStatus: 'Casado',
      academicInstruction: 'Universitaria',
      phoneNumber: '+593987654321',
      address: 'Cdla. Los Ceibos, Mz. 4, Villa 12',
    },
  },

  // Guard Shifts
  'POST /tenant/{tenantId}/guard-shift': {
    request: {
      data: {
        stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        guardNameId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        punchInTime: '2026-06-07T07:55:00.000Z',
        shiftSchedule: 'Diurno',
        observations: 'Inicio de turno sin novedades.',
      },
    },
  },

  // Guard mobile endpoints
  'POST /tenant/{tenantId}/guard/me/clock-in': {
    request: {
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      latitude: -0.180653,
      longitude: -78.467834,
      shiftSchedule: 'Diurno',
      observations: 'Inicio de turno.',
      battery: 92,
      address: 'Av. República y Pradera, Quito',
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      punchInTime: '2026-06-07T07:55:00.000Z',
      shiftSchedule: 'Diurno',
      status: 'active',
    },
  },
  'POST /tenant/{tenantId}/guard/me/clock-out': {
    request: {
      latitude: -0.180221,
      longitude: -78.467912,
      observations: 'Fin de turno. Sin novedades.',
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      punchOutTime: '2026-06-07T19:05:00.000Z',
      totalHours: 11.17,
      status: 'completed',
    },
  },
  'POST /tenant/{tenantId}/guard/me/incident': {
    request: {
      title: 'Persona sospechosa en estacionamiento',
      description: 'Se observó individuo merodeando en el nivel B2 del estacionamiento sin vehículo.',
      priority: 'alta',
      location: 'Estacionamiento Nivel B2',
      latitude: -0.176089,
      longitude: -78.480148,
    },
  },
  'POST /tenant/{tenantId}/guard/me/device': {
    request: {
      deviceId: 'ABC123DEF456',
      model: 'Samsung Galaxy A54',
      os: 'Android 14',
      appVersion: '2.5.1',
    },
  },
  'POST /tenant/{tenantId}/guard/me/device-token': {
    request: {
      token: 'fcm_token_abc123xyz789...',
      platform: 'ios',
    },
  },
  'POST /tenant/{tenantId}/guard/me/patrol/start': {
    request: {
      patrolId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      latitude: -0.180653,
      longitude: -78.467834,
    },
  },

  // Incidents
  'POST /tenant/{tenantId}/incident': {
    request: {
      title: 'Intento de ingreso no autorizado',
      description: 'Se detectó persona intentando ingresar por puerta lateral sin credenciales.',
      date: '2026-06-07T14:35:00.000Z',
      priority: 'alta',
      status: 'abierto',
      postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      action: 'Se notificó al supervisor y se registró en bitácora.',
    },
  },

  // Patrol
  'POST /tenant/{tenantId}/patrol': {
    request: {
      data: {
        scheduledTime: '2026-06-07T22:00:00.000Z',
        station: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        assignedGuard: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        checkpoints: ['checkpoint-uuid-1', 'checkpoint-uuid-2', 'checkpoint-uuid-3'],
      },
    },
  },
  'POST /tenant/{tenantId}/patrol-checkpoint': {
    request: {
      data: {
        name: 'Puerta Lateral Este',
        description: 'Verificar cerraduras y cámaras del sector.',
        latitude: -0.177012,
        longitude: -78.479856,
        order: 1,
        patrolId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      },
    },
  },

  // Invoice
  'POST /tenant/{tenantId}/invoice': {
    request: {
      clientId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      invoiceNumber: 'FAC-2026-000142',
      date: '2026-06-07',
      dueDate: '2026-07-07',
      items: [
        { description: 'Servicio de guardianía 24/7 - Junio 2026', quantity: 720, rate: 8.50, taxRate: 12 },
        { description: 'Equipo de comunicaciones (alquiler)', quantity: 1, rate: 150.00, taxRate: 12 },
      ],
      notes: 'Pago a 30 días. Transferencia bancaria.',
      subtotal: 6270.00,
      total: 7022.40,
      status: 'Borrador',
    },
  },

  // Estimate
  'POST /tenant/{tenantId}/estimate': {
    request: {
      clientId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      date: '2026-06-07',
      validUntil: '2026-07-07',
      items: [
        { description: 'Servicio de guardianía 12h diurno', quantity: 30, rate: 12.50 },
        { description: 'Monitoreo CCTV remoto', quantity: 1, rate: 800.00 },
      ],
      notes: 'Cotización válida por 30 días.',
      total: 1175.00,
    },
  },

  // Invoices
  'POST /tenant/{tenantId}/payment': {
    request: {
      invoiceId: '550e8400-e29b-41d4-a716-446655440000',
      amount: 7022.40,
      method: 'transferencia',
      reference: 'TRF-20260607-001',
      date: '2026-06-07',
    },
  },

  // Notification
  'POST /tenant/{tenantId}/notification': {
    request: {
      data: {
        title: 'Alerta de seguridad',
        message: 'Se ha reportado un incidente en el sector norte. Todos los guardias del turno nocturno favor reportarse.',
        type: 'alert',
        recipientIds: ['9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d'],
      },
    },
  },

  // Tasks
  'POST /tenant/{tenantId}/task': {
    request: {
      data: {
        title: 'Revisión de extintores',
        description: 'Verificar fecha de vencimiento y presión de todos los extintores del edificio.',
        dueDate: '2026-06-15',
        assignedTo: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        priority: 'media',
        status: 'pendiente',
      },
    },
  },

  // Memos
  'POST /tenant/{tenantId}/memos': {
    request: {
      data: {
        title: 'Cambio de protocolo de ingreso',
        body: 'A partir del lunes 10 de junio, todos los visitantes deberán presentar cédula de identidad y registrar huella digital en el sistema.',
        priority: 'alta',
        targetRoles: ['securityGuard', 'securitySupervisor'],
      },
    },
  },

  // Shifts
  'POST /tenant/{tenantId}/shift': {
    request: {
      postSite: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      tenantUserId: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
      station: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      startAt: '2026-06-08T07:00:00.000Z',
      endAt: '2026-06-08T19:00:00.000Z',
    },
  },

  // Time off
  'POST /tenant/{tenantId}/time-off-request': {
    request: {
      startDate: '2026-06-20',
      endDate: '2026-06-22',
      reason: 'Cita médica programada y exámenes de laboratorio.',
      type: 'permiso_medico',
    },
  },

  // Shift exchange
  'POST /tenant/{tenantId}/shift-exchange-request': {
    request: {
      shiftId: '550e8400-e29b-41d4-a716-446655440000',
      targetGuardId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      reason: 'Necesito cubrir una emergencia familiar.',
    },
  },

  // Vehicle
  'POST /tenant/{tenantId}/vehicle': {
    request: {
      data: {
        plate: 'PBX-1234',
        brand: 'Toyota',
        model: 'Hilux',
        year: 2024,
        color: 'Blanco',
        type: 'Camioneta',
        status: 'activo',
        assignedTo: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
    },
  },

  // Route
  'POST /tenant/{tenantId}/route': {
    request: {
      data: {
        name: 'Ruta Patrullaje Norte',
        description: 'Recorrido por el sector norte del complejo industrial.',
        checkpoints: [
          { latitude: -0.176089, longitude: -78.480148, name: 'Punto A - Garita Norte' },
          { latitude: -0.177500, longitude: -78.479200, name: 'Punto B - Estacionamiento' },
          { latitude: -0.178200, longitude: -78.478100, name: 'Punto C - Bodega' },
        ],
        estimatedDuration: 45,
      },
    },
  },

  // Messages
  'POST /tenant/{tenantId}/message': {
    request: {
      recipientId: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
      subject: 'Cambio de horario',
      body: 'Se le informa que su turno del viernes ha sido reasignado al sábado.',
    },
  },

  // Scheduling
  'POST /tenant/{tenantId}/guard-assignment': {
    request: {
      guardId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      startDate: '2026-06-10',
      endDate: '2026-12-31',
      shiftType: 'Diurno',
    },
  },

  // Attendance
  'PUT /tenant/{tenantId}/attendance/settings': {
    request: {
      data: {
        lateThresholdMinutes: 15,
        earlyClockOutThresholdMinutes: 30,
        autoApproveClockIn: false,
        requireSelfie: true,
        geofenceEnabled: true,
        payPeriod: 'quincenal',
        overtimeMultiplier: 1.5,
      },
    },
  },
  'POST /tenant/{tenantId}/attendance/close-period': {
    request: {
      data: {
        startDate: '2026-06-01',
        endDate: '2026-06-15',
        notes: 'Primera quincena junio 2026',
      },
    },
  },

  // Business Info
  'POST /tenant/{tenantId}/business-info': {
    request: {
      data: {
        companyName: 'Seguridad Elite S.A.',
        ruc: '1790012345001',
        legalRepresentative: 'Juan Pérez Molina',
        address: 'Av. Amazonas N24-196 y Colón',
        city: 'Quito',
        country: 'Ecuador',
        phone: '+593-2-2505050',
        email: 'admin@seguridadelite.com',
      },
    },
  },

  // Subscription
  'POST /tenant/{tenantId}/subscription': {
    request: {
      planId: 'plan_professional',
      billingCycle: 'monthly',
    },
  },

  // KPI
  'POST /tenant/{tenantId}/kpi': {
    request: {
      name: 'Tasa de Puntualidad',
      description: 'Porcentaje de guardias que llegan a tiempo a su turno.',
      targetValue: 95,
      unit: 'porcentaje',
      frequency: 'semanal',
      assignedTo: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
    },
  },

  // Inquiry
  'POST /tenant/{tenantId}/inquiries': {
    request: {
      data: {
        subject: 'Solicitud de cotización',
        message: 'Requerimos cotización para servicio de guardianía 24/7 para bodega industrial.',
        contactName: 'Roberto Silva',
        contactEmail: 'roberto.silva@empresa.com',
        contactPhone: '+593991234567',
      },
    },
  },

  // Certification
  'POST /tenant/{tenantId}/certification': {
    request: {
      data: {
        name: 'Certificación COSP',
        description: 'Certificado de Operador de Seguridad Privada emitido por el Ministerio del Interior.',
        expirationDate: '2027-12-31',
        guardId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        certificationNumber: 'COSP-2025-4521',
      },
    },
  },

  // Site Tour (Ronda)
  'POST /tenant/{tenantId}/site-tour': {
    request: {
      name: 'Ronda Nocturna - Perímetro',
      description: 'Recorrido de vigilancia por todo el perímetro del complejo.',
      scheduledDays: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes'],
      continuous: false,
      timeMode: 'scheduled',
      selectTime: '22:00',
      maxDuration: 60,
      active: true,
      postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    },
  },

  // Superadmin
  'POST /superadmin/tenants': {
    request: {
      name: 'Nueva Empresa Seguridad',
      plan: 'professional',
      ownerEmail: 'admin@nuevaempresa.com',
      maxUsers: 50,
    },
  },
  'POST /superadmin/tenants/{id}/suspend': {
    request: {
      reason: 'Falta de pago - 90 días de mora.',
    },
  },

  // ─── Inquiries ───────────────────────────────────────────────────────────
  'POST /tenant/{tenantId}/inquiries': {
    request: {
      data: {
        names: 'Roberto Silva',
        city: 'Guayaquil',
        email: 'roberto.silva@constructora.com',
        phoneNumber: '0991234567',
        message: 'Necesitamos cotización para servicio de guardianía 24/7 en bodega industrial sector Vía Daule km 12.',
        serviceOfInterest: '550e8400-e29b-41d4-a716-446655440000',
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      names: 'Roberto Silva',
      city: 'Guayaquil',
      email: 'roberto.silva@constructora.com',
      phoneNumber: '0991234567',
      message: 'Necesitamos cotización para servicio de guardianía 24/7 en bodega industrial sector Vía Daule km 12.',
      createdAt: '2026-06-07T10:00:00.000Z',
    },
  },
  'PUT /tenant/{tenantId}/inquiries/{id}': {
    request: {
      data: {
        names: 'Roberto Silva',
        city: 'Guayaquil',
        email: 'roberto.silva@constructora.com',
        phoneNumber: '0991234567',
        message: 'Actualización: requieren servicio a partir del 1 de julio.',
        serviceOfInterest: '550e8400-e29b-41d4-a716-446655440000',
      },
      id: '550e8400-e29b-41d4-a716-446655440000',
    },
  },

  // ─── Inventory ───────────────────────────────────────────────────────────
  'POST /tenant/{tenantId}/inventory': {
    request: {
      data: {
        belongsTo: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        name: 'Equipo Guardia Puesto Norte',
        radio: true,
        radioType: 'Motorola T200',
        radioSerialNumber: 'MOT-2025-78432',
        gun: true,
        gunType: 'pistola de fogeo',
        gunSerialNumber: 'PF-2024-11234',
        armor: true,
        armorType: 'Chaleco nivel IIIA',
        armorSerialNumber: 'CHL-2024-5567',
        armorExpirationDate: '2028-12-31',
        tolete: true,
        pito: true,
        linterna: true,
        vitacora: true,
        cintoCompleto: true,
        ponchoDeAguas: false,
        detectorDeMetales: false,
        caseta: true,
        transportation: 'Ninguno',
        observations: 'Equipo completo asignado al turno diurno.',
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Equipo Guardia Puesto Norte',
      radio: true,
      radioType: 'Motorola T200',
      gun: true,
      gunType: 'pistola de fogeo',
      armor: true,
      armorType: 'Chaleco nivel IIIA',
      createdAt: '2026-06-07T10:00:00.000Z',
    },
  },
  'PUT /tenant/{tenantId}/inventory/{id}': {
    request: {
      data: {
        name: 'Equipo Guardia Puesto Norte',
        observations: 'Linterna reemplazada por daño. Nueva: Streamlight Stinger.',
        linterna: true,
      },
      id: '550e8400-e29b-41d4-a716-446655440000',
    },
  },

  // ─── Inventory Assignment ────────────────────────────────────────────────
  'POST /tenant/{tenantId}/inventory-assignment': {
    request: {
      inventoryItemId: '550e8400-e29b-41d4-a716-446655440000',
      assignedToUserId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      conditionAtCheckout: 'bueno',
      notes: 'Entrega de equipo completo para turno nocturno.',
    },
    response: {
      id: 'b1c2d3e4-f5a6-7890-bcde-f12345678901',
      inventoryItemId: '550e8400-e29b-41d4-a716-446655440000',
      assignedToUserId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      assignedAt: '2026-06-07T19:00:00.000Z',
      conditionAtCheckout: 'bueno',
      status: 'asignado',
    },
  },
  'PATCH /tenant/{tenantId}/inventory-assignment/{id}': {
    request: {
      returnedAt: '2026-06-08T07:05:00.000Z',
      conditionAtReturn: 'bueno',
      returnNotes: 'Devuelto sin novedades al fin del turno nocturno.',
    },
  },

  // ─── Representante Empresa ───────────────────────────────────────────────
  'POST /tenant/{tenantId}/representante-empresa': {
    request: {
      data: {
        governmentId: '1790012345',
        jobTitle: 'Gerente de Operaciones',
        personInCharge: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
        assignedCompany: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      governmentId: '1790012345',
      jobTitle: 'Gerente de Operaciones',
      personInCharge: {
        id: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
        fullName: 'Juan Pérez Molina',
      },
      assignedCompany: {
        id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        name: 'Corporación Nacional de Telecomunicaciones',
      },
      createdAt: '2026-06-07T10:00:00.000Z',
    },
  },
  'PUT /tenant/{tenantId}/representante-empresa/{id}': {
    request: {
      data: {
        governmentId: '1790012345',
        jobTitle: 'Director de Seguridad',
        personInCharge: '9a3b5c7d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
        assignedCompany: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      },
      id: '550e8400-e29b-41d4-a716-446655440000',
    },
  },

  // ─── Patrol Log (Patrol History) ─────────────────────────────────────────
  'POST /tenant/{tenantId}/patrol-log': {
    request: {
      data: {
        patrol: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        scanTime: '2026-06-07T22:15:00.000Z',
        latitude: -0.177012,
        longitude: -78.479856,
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      patrol: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      scanTime: '2026-06-07T22:15:00.000Z',
      latitude: -0.177012,
      longitude: -78.479856,
      validLocation: true,
      status: 'Scanned',
      scannedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    },
  },
  'PUT /tenant/{tenantId}/patrol-log/{id}': {
    request: {
      data: {
        patrol: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        scanTime: '2026-06-07T22:15:00.000Z',
        latitude: -0.177012,
        longitude: -78.479856,
        status: 'Scanned',
      },
      id: '550e8400-e29b-41d4-a716-446655440000',
    },
  },

  // ─── Visitor Log ─────────────────────────────────────────────────────────
  'POST /tenant/{tenantId}/visitor-log': {
    request: {
      data: {
        visitDate: '2026-06-07T09:30:00.000Z',
        firstName: 'María',
        lastName: 'González',
        idNumber: '1714567890',
        idType: 'Cédula',
        reason: 'Reunión con Gerencia de TI',
        personVisited: 'Ing. Roberto Vaca',
        company: 'Soluciones Tecnológicas S.A.',
        numPeople: 1,
        stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        vehiclePlate: 'PBC-4567',
        vehicleType: 'Sedán',
        phone: '+593987111222',
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      visitDate: '2026-06-07T09:30:00.000Z',
      firstName: 'María',
      lastName: 'González',
      idNumber: '1714567890',
      reason: 'Reunión con Gerencia de TI',
      personVisited: 'Ing. Roberto Vaca',
      stationName: 'Puesto Norte - Entrada Principal',
      exitTime: null,
      createdAt: '2026-06-07T09:30:00.000Z',
    },
  },

  // ─── Incident Dispatch ───────────────────────────────────────────────────
  'POST /tenant/{tenantId}/incident/{id}/dispatch': {
    request: {
      data: {
        clientId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        siteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        stationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        guardId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        priority: 'alta',
        content: 'Se requiere presencia inmediata de guardia adicional en puerta lateral.',
        location: 'Puerta lateral sector B',
        callerName: 'Supervisor Morales',
        callerType: 'Supervisor',
        subject: 'Refuerzo por intento de ingreso',
      },
    },
    response: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      status: 'dispatched',
      incidentId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      createdAt: '2026-06-07T14:40:00.000Z',
    },
  },

  // ─── Incident Update ─────────────────────────────────────────────────────
  'PUT /tenant/{tenantId}/incident/{id}': {
    request: {
      data: {
        title: 'Intento de ingreso no autorizado',
        description: 'Se detectó persona intentando ingresar por puerta lateral. Fue interceptado y retirado del área.',
        status: 'cerrado',
        actionsTaken: 'Se alertó a patrulla móvil, se revisaron cámaras, se reforzó vigilancia en sector.',
        internalNotes: 'Individuo identificado. Se añadió a lista de no admitidos.',
      },
      id: '550e8400-e29b-41d4-a716-446655440000',
    },
  },
};

// ─── Response examples for GET list endpoints ────────────────────────────────
const listResponseExamples = {
  '/tenant/{tenantId}/client-account': {
    rows: [
      {
        id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        name: 'Corporación Nacional de Telecomunicaciones',
        email: 'seguridad@cnt.gob.ec',
        phoneNumber: '+593-2-2900100',
        address: 'Av. Japón N35-55 y Naciones Unidas',
        city: 'Quito',
        active: true,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/post-site': {
    rows: [
      {
        id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        companyName: 'Centro Comercial Quicentro Norte',
        address: 'Av. Naciones Unidas E2-30',
        city: 'Quito',
        serviceType: 'manned',
        active: true,
        guardsCount: 8,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/security-guard': {
    rows: [
      {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        firstName: 'Carlos',
        lastName: 'Mendez',
        governmentId: '1712345678',
        phoneNumber: '+593987654321',
        active: true,
        currentStation: 'Puesto Norte',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/station': {
    rows: [
      {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        stationName: 'Puesto Norte - Entrada Principal',
        nickname: 'Norte-1',
        numberOfGuardsInStation: '2',
        startingTimeInDay: '07:00',
        finishTimeInDay: '19:00',
        geofenceRadius: 100,
        active: true,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/incident': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Intento de ingreso no autorizado',
        date: '2026-06-07T14:35:00.000Z',
        priority: 'alta',
        status: 'abierto',
        postSiteName: 'Quicentro Norte',
        guardName: 'Carlos Mendez',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/guard-shift': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        guardName: 'Carlos Mendez',
        stationName: 'Puesto Norte',
        punchInTime: '2026-06-07T07:55:00.000Z',
        punchOutTime: '2026-06-07T19:05:00.000Z',
        shiftSchedule: 'Diurno',
        totalHours: 11.17,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/invoice': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        invoiceNumber: 'FAC-2026-000142',
        clientName: 'Corporación Nacional de Telecomunicaciones',
        date: '2026-06-07',
        dueDate: '2026-07-07',
        total: 7022.40,
        status: 'Borrador',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/patrol': {
    rows: [
      {
        id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        scheduledTime: '2026-06-07T22:00:00.000Z',
        status: 'Completed',
        guardName: 'Carlos Mendez',
        stationName: 'Puesto Norte',
        checkpointsCompleted: 3,
        checkpointsTotal: 3,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/shift': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        guardName: 'Carlos Mendez',
        postSiteName: 'Quicentro Norte',
        stationName: 'Puesto Norte',
        startAt: '2026-06-08T07:00:00.000Z',
        endAt: '2026-06-08T19:00:00.000Z',
        status: 'scheduled',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/memos': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Cambio de protocolo de ingreso',
        priority: 'alta',
        createdAt: '2026-06-07T10:00:00.000Z',
        readCount: 12,
        totalRecipients: 25,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/inquiries': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        names: 'Roberto Silva',
        city: 'Guayaquil',
        email: 'roberto.silva@constructora.com',
        phoneNumber: '0991234567',
        message: 'Necesitamos cotización para servicio de guardianía 24/7.',
        createdAt: '2026-06-07T10:00:00.000Z',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/inventory': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Equipo Guardia Puesto Norte',
        belongsToStation: 'Puesto Norte',
        radio: true,
        gun: true,
        armor: true,
        transportation: 'Ninguno',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/inventory-assignment': {
    rows: [
      {
        id: 'b1c2d3e4-f5a6-7890-bcde-f12345678901',
        inventoryItemName: 'Equipo Guardia Puesto Norte',
        assignedToName: 'Carlos Mendez',
        stationName: 'Puesto Norte',
        assignedAt: '2026-06-07T19:00:00.000Z',
        returnedAt: null,
        conditionAtCheckout: 'bueno',
        status: 'asignado',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/representante-empresa': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        governmentId: '1790012345',
        jobTitle: 'Gerente de Operaciones',
        personInChargeName: 'Juan Pérez Molina',
        assignedCompanyName: 'Corporación Nacional de Telecomunicaciones',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/patrol-log': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        patrol: 'Ronda Nocturna - Perímetro',
        scanTime: '2026-06-07T22:15:00.000Z',
        latitude: -0.177012,
        longitude: -78.479856,
        validLocation: true,
        status: 'Scanned',
        scannedByName: 'Carlos Mendez',
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/visitor-log': {
    rows: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        visitDate: '2026-06-07T09:30:00.000Z',
        firstName: 'María',
        lastName: 'González',
        idNumber: '1714567890',
        reason: 'Reunión con Gerencia de TI',
        personVisited: 'Ing. Roberto Vaca',
        company: 'Soluciones Tecnológicas S.A.',
        stationName: 'Puesto Norte',
        exitTime: null,
      },
    ],
    count: 1,
  },
  '/tenant/{tenantId}/attendance/dashboard': null, // special handling
  '/auth/me': null, // special handling
};

// ─── Special response examples ───────────────────────────────────────────────
const specialResponses = {
  'GET /customer/me/account': {
    clientAccount: {
      id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      name: 'Corporación Nacional de Telecomunicaciones',
      email: 'seguridad@cnt.gob.ec',
      phoneNumber: '+593-2-2900100',
      address: 'Av. Japón N35-55 y Naciones Unidas',
      city: 'Quito',
      country: 'Ecuador',
      active: true,
      onboardingStatus: 'completed',
      logoUrl: [],
      placePictureUrl: [],
    },
    postSites: [
      {
        id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        companyName: 'Edificio CNT Matriz',
        address: 'Av. Japón N35-55',
        city: 'Quito',
        latitud: -0.176089,
        longitud: -78.480148,
        stations: [
          {
            id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            stationName: 'Puesto Norte - Entrada Principal',
            latitud: -0.176089,
            longitud: -78.480148,
            startingTimeInDay: '07:00',
            finishTimeInDay: '19:00',
            numberOfGuardsInStation: '2',
          },
        ],
      },
    ],
    guards: [
      {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        fullName: 'Carlos Mendez',
        isOnDuty: true,
        gender: 'Masculino',
        governmentId: '1712345678',
        photoUrl: 'https://storage.cguardpro.com/guards/carlos-mendez.jpg',
      },
    ],
    incidents: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Intento de ingreso no autorizado',
        description: 'Se detectó persona en puerta lateral sin credenciales.',
        incidentAt: '2026-06-07T14:35:00.000Z',
        severity: 'alta',
        postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      },
    ],
    activeShifts: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        startTime: '2026-06-07T07:00:00.000Z',
        endTime: '2026-06-07T19:00:00.000Z',
        guardId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        postSiteId: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      },
    ],
    inventory: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Equipo Guardia Puesto Norte',
        radio: true,
        gun: true,
        armor: true,
        belongsToStation: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      },
    ],
    patrols: [
      {
        id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
        scheduledTime: '2026-06-07T22:00:00.000Z',
        completionTime: '2026-06-07T22:45:00.000Z',
        status: 'Completed',
        completed: true,
        station: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        assignedGuard: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      },
    ],
  },
  'GET /auth/me': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'carlos.mendez@empresa.com',
    fullName: 'Carlos Mendez',
    firstName: 'Carlos',
    lastName: 'Mendez',
    phoneNumber: '+593987654321',
    emailVerified: true,
    tenants: [
      {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'Seguridad Elite S.A.',
        roles: ['admin'],
      },
    ],
  },
  'GET /tenant/{tenantId}/guard/me': {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    firstName: 'Carlos',
    lastName: 'Mendez',
    email: 'carlos.mendez@empresa.com',
    phoneNumber: '+593987654321',
    governmentId: '1712345678',
    currentShift: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      stationName: 'Puesto Norte',
      punchInTime: '2026-06-07T07:55:00.000Z',
      shiftSchedule: 'Diurno',
    },
    isOnDuty: true,
  },
  'GET /tenant/{tenantId}/guard/me/schedule': [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      stationName: 'Puesto Norte - Entrada Principal',
      postSiteName: 'Quicentro Norte',
      startAt: '2026-06-08T07:00:00.000Z',
      endAt: '2026-06-08T19:00:00.000Z',
      shiftType: 'Diurno',
    },
    {
      id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      stationName: 'Puesto Sur - Estacionamiento',
      postSiteName: 'Quicentro Norte',
      startAt: '2026-06-09T19:00:00.000Z',
      endAt: '2026-06-10T07:00:00.000Z',
      shiftType: 'Nocturno',
    },
  ],
  'GET /tenant/{tenantId}/guard/me/patrols': [
    {
      id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
      name: 'Ronda Nocturna - Perímetro',
      scheduledTime: '2026-06-07T22:00:00.000Z',
      status: 'pending',
      checkpoints: 5,
    },
  ],
  'GET /tenant/{tenantId}/attendance/dashboard': {
    totalGuards: 45,
    onDuty: 18,
    late: 2,
    absent: 1,
    totalHoursToday: 198.5,
    exceptions: 3,
    pendingApprovals: 5,
  },
  'GET /tenant/{tenantId}/dashboard/stats': {
    totalGuards: 45,
    activeGuards: 42,
    totalClients: 12,
    totalPostSites: 28,
    totalStations: 64,
    incidentsThisMonth: 7,
    shiftsToday: 36,
    onDutyNow: 18,
  },
  'GET /tenant/{tenantId}/operations/analytics': {
    coverage: { percentage: 94.2, gaps: 3 },
    punctuality: { onTime: 89, late: 6, absent: 2 },
    incidents: { total: 7, resolved: 5, pending: 2 },
    patrols: { completed: 124, missed: 3, completionRate: 97.6 },
  },
};

module.exports = { fieldExamples, routeExamples, listResponseExamples, specialResponses };
