/**
 * PM2 Ecosystem Configuration for CGUARD Backend
 * 
 * SCALABILITY: Configured for 10K+ tenants with cluster mode
 * 
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production  (zero-downtime reload)
 *   pm2 scale cguard-backend +2  (add 2 more instances)
 */

module.exports = {
  apps: [
    {
      name: 'cguard-backend',
      script: './dist/server.js',
      
      // ============================================================
      // CLUSTER MODE - Critical for 10K+ tenants
      // ============================================================
      // 'max' uses all available CPU cores
      // For 10K tenants, recommend 4-8 instances minimum
      instances: process.env.PM2_INSTANCES || 'max',
      exec_mode: 'cluster',
      
      // ============================================================
      // MEMORY & RESTART POLICIES
      // ============================================================
      max_memory_restart: '1G',           // Restart if memory exceeds 1GB
      min_uptime: '10s',                  // Min uptime to consider "started"
      max_restarts: 10,                   // Max restarts in restart_delay window
      restart_delay: 4000,                // Wait 4s between restarts
      
      // ============================================================
      // ZERO-DOWNTIME DEPLOYMENTS
      // ============================================================
      wait_ready: true,                   // Wait for process.send('ready')
      listen_timeout: 10000,              // 10s timeout for ready signal
      kill_timeout: 5000,                 // 5s graceful shutdown timeout
      
      // ============================================================
      // LOGGING
      // ============================================================
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,                   // Merge logs from all instances
      
      // ============================================================
      // ENVIRONMENT VARIABLES
      // ============================================================
      env: {
        NODE_ENV: 'development',
        API_DOCUMENTATION_ENABLED: 'true',
        PORT: 8080,
        TENANT_MODE: 'multi',
      },
      env_production: {
        NODE_ENV: 'production',
        API_DOCUMENTATION_ENABLED: 'true',
        PORT: 8080,
        TENANT_MODE: 'multi',
        
        // Database pool for production
        DATABASE_POOL_MAX: '50',
        DATABASE_POOL_MIN: '10',
        DATABASE_POOL_ACQUIRE: '30000',
        DATABASE_POOL_IDLE: '10000',
      },
      env_staging: {
        NODE_ENV: 'staging',
        API_DOCUMENTATION_ENABLED: 'true',
        PORT: 8080,
        TENANT_MODE: 'multi',
        DATABASE_POOL_MAX: '25',
        DATABASE_POOL_MIN: '5',
      },
    },
  ],
  
  // ============================================================
  // DEPLOYMENT CONFIGURATION
  // ============================================================
  deploy: {
    production: {
      user: 'cguardpro',
      host: ['192.168.86.23'],
      ref: 'origin/main',
      repo: 'git@github.com:your-org/cguard-backend.git',
      path: '/home/cguardpro/cguard-backend',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
