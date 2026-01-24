require('dotenv').config()
import api from './api'
import { databaseInit } from './database/databaseConnection';
import TenantInvitationRepository from './database/repositories/tenantInvitationRepository';
import { setInterval as nodeSetInterval } from 'timers';

// const PORT = process.env.PORT || 8080
const PORT = Number(process.env.PORT) || 3001

const tenantMode = process.env.TENANT_MODE || 'multi';
console.log(`TENANT_MODE: ${tenantMode}`);

// Robust start: if port is in use, try the next ports up to a limit
function startServer(port: number, attemptsLeft = 5) {
  const server = api.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });

  server.on('error', (err: any) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use.`);
      if (attemptsLeft > 0) {
        const nextPort = port + 1;
        console.log(`Attempting to listen on port ${nextPort} (attempts left: ${attemptsLeft - 1})`);
        // small delay before retrying
        setTimeout(() => startServer(nextPort, attemptsLeft - 1), 250);
      } else {
        console.error('All retry attempts failed. Either free the port or set PORT env var to a different value.');
        console.error('On Windows, run: netstat -ano | findstr :<PORT>  then taskkill /PID <PID> /F');
        process.exit(1);
      }
    } else {
      console.error('Server error during startup:', err);
      process.exit(1);
    }
  });

  return server;
}

startServer(PORT, 5);

// Periodic cleanup: remove expired tenant invitations every 3 hours
async function runExpiredInvitesCleanup() {
  try {
    const database = await databaseInit();
    const deleted = await TenantInvitationRepository.deleteExpired({
      database,
      language: '',
      currentUser: undefined,
      currentTenant: undefined
    });
    if (deleted && deleted > 0) {
      console.log(`Expired tenant invitations cleanup: deleted ${deleted} rows`);
    }
  } catch (err) {
    console.error('Error cleaning expired tenant invitations:', err);
  }
}

// Run once at startup
runExpiredInvitesCleanup();

// Schedule periodic cleanup every 3 hours
nodeSetInterval(() => {
  runExpiredInvitesCleanup();
}, 3 * 60 * 60 * 1000);

