
class Roles {
  static get values() {
    return {
      // System Administration
      admin: 'admin',
      
      // Management Hierarchy
      operationsManager: 'operationsManager',
      securitySupervisor: 'securitySupervisor',
      clientAccountManager: 'clientAccountManager',
      hrManager: 'hrManager',
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
      clientAccountManager: 70,
      hrManager: 70,
      dispatcher: 60,
      securityGuard: 50,
      customer: 10,
      custom: 1,
    };
  }

  static get descriptions() {
    return {
      admin: 'System Administrator - Full system access',
      operationsManager: 'Operations Manager - Oversees all security operations',
      securitySupervisor: 'Security Supervisor - Manages security guards and daily operations',
      clientAccountManager: 'Client Account Manager - Manages client relationships and accounts',
      hrManager: 'HR Manager - Manages personnel, training, and certifications',
      dispatcher: 'Dispatcher - Manages schedules, shifts, and guard assignments',
      securityGuard: 'Security Guard - Front-line security personnel',
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
