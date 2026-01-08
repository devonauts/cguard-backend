
class Roles {
  static get values() {
    return {
      // System Administration
      admin: 'admin',
      // Management / Operations
      operationsManager: 'operationsManager',

      // Management / Supervisors
      securitySupervisor: 'securitySupervisor',
      hrManager: 'hrManager',
      clientAccountManager: 'clientAccountManager',
      dispatcher: 'dispatcher',

      // Operational Roles
      securityGuard: 'securityGuard',

      // External Users
      customer: 'customer',

      // Legacy/Custom (kept for backward compatibility)
      custom: 'custom',
    };
  }

  static get hierarchy() {
    // Higher numbers = higher authority
    return {
      admin: 100,
      operationsManager: 90,
      securitySupervisor: 80,
      hrManager: 75,
      clientAccountManager: 70,
      dispatcher: 60,
      securityGuard: 50,
      customer: 10,
      custom: 1,
    };
  }

  static get descriptions() {
    return {
      admin: 'System Administrator - Full system access',
      operationsManager: 'Operations Manager - Oversees operations and clients',
      securitySupervisor: 'Security Supervisor - Supervises guards and incidents',
      hrManager: 'HR Manager - Manages personnel and certifications',
      clientAccountManager: 'Client Account Manager - Manages client accounts',
      dispatcher: 'Dispatcher - Manages scheduling and shifts',
      securityGuard: 'Security Guard - Operational guard role',
      customer: 'Customer - Client access to assigned services',
      custom: 'Custom Role - Configurable permissions',
    };
  }

  static hasHigherAuthority(role1, role2) {
    const hierarchy = this.hierarchy;
    return (hierarchy[role1] || 0) > (hierarchy[role2] || 0);
  }
}

export default Roles;
