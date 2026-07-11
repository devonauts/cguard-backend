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
      // The working set legitimately climbs to ~450MB under load (Node + Sequelize
      // + pools + caches), so a 450M ceiling was recycling workers every ~2h for
      // nothing. 900M gives real headroom on the 15GB box (2×900M) and still traps
      // a genuine runaway. A slow leak is caught by the RSS-trend alert, not this.
      max_memory_restart: '900M',         // Restart a worker only if it exceeds 900MB
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

        // Cross-instance realtime (socket.io Redis adapter + fleet-wide rate
        // limiter). REQUIRED whenever `instances` > 1: without it, cross-worker
        // emits — including PANIC/alarm broadcasts — only reach sockets on the
        // emitting worker. Pinned here (not only in the untracked .env) so a
        // re-provision or .env loss can't silently break panic delivery.
        // dotenv does not override an already-set process.env, and .env also
        // carries the same value, so this is a durable, consistent default.
        REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

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
    {
      // RoIP / SIP bridge — relays audio between tenant radio gateways and the app
      // PTT channel. MUST be fork mode / 1 instance (owns SIP + RTP UDP sockets,
      // can't be load-balanced across cluster workers). DISABLED by default
      // (autostart:false) — start only once gateway creds + UDP networking are in
      // place: `pm2 start ecosystem.config.js --only cguard-sip-bridge --env production`.
      name: 'cguard-sip-bridge',
      script: './dist/sipBridge.js',
      cwd: '/home/cguardpro/cguard-backend',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Not started by a blanket `pm2 reload ecosystem.config.js` until enabled.
      // (Remove this flag / start explicitly when going live.)
      // eslint-disable-next-line
      autostart: false,
      max_memory_restart: '300M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/sip-bridge-error.log',
      out_file: './logs/sip-bridge-out.log',
      env: {
        NODE_ENV: 'development',
        TENANT_MODE: 'multi',
      },
      env_production: {
        NODE_ENV: 'production',
        TENANT_MODE: 'multi',
        DATABASE_POOL_MAX: '5',
        DATABASE_POOL_MIN: '1',
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
