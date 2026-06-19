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
      cwd: '/home/cguardpro/cguard-backend',
      
      // ============================================================
      // CLUSTER MODE - Critical for 10K+ tenants
      // ============================================================
      // Default 2 instances — plenty for the current load and ~halves backend
      // RAM vs 'max' (1 worker per core). Scale up anytime without a deploy:
      //   PM2_INSTANCES=4 pm2 reload ecosystem.config.js   (or: pm2 scale cguard-backend 4)
      // For 10K tenants, bump to 4-8.
      instances: Number(process.env.PM2_INSTANCES) || 2,
      exec_mode: 'cluster',

      // ============================================================
      // MEMORY & RESTART POLICIES
      // ============================================================
      // Baseline is ~175MB/worker; restart well above that to catch a real leak
      // early without flapping. Raise for heavy production load.
      max_memory_restart: '450M',         // Restart a worker if it exceeds 450MB
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
        // Firebase service-account for push (file lives outside the repo on the server)
        FIREBASE_SERVICE_ACCOUNT_FILE: '/home/cguardpro/firebase-service-account.json',

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
    {
      // Alarm signal receiver (SIA DC-09 / Contact ID / Sur-Gard) — a single
      // long-running TCP/UDP listener. MUST be fork mode / 1 instance (a socket
      // listener can't be load-balanced across cluster workers).
      name: 'cguard-alarm-receiver',
      script: './dist/alarmReceiver.js',
      cwd: '/home/cguardpro/cguard-backend',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/alarm-error.log',
      out_file: './logs/alarm-out.log',
      env: {
        NODE_ENV: 'development',
        ALARM_TCP_PORT: 6543,
        ALARM_UDP_PORT: 6543,
        TENANT_MODE: 'multi',
      },
      env_production: {
        NODE_ENV: 'production',
        ALARM_TCP_PORT: 6543,
        ALARM_UDP_PORT: 6543,
        TENANT_MODE: 'multi',
        FIREBASE_SERVICE_ACCOUNT_FILE: '/home/cguardpro/firebase-service-account.json',
        DATABASE_POOL_MAX: '10',
        DATABASE_POOL_MIN: '2',
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
      'post-deploy': 'npm install && npm run build && npm run migrate:all && npm run migrate:sql && npm run db:verify && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
