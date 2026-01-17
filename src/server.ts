require('dotenv').config()
import api from './api'
import { databaseInit } from './database/databaseConnection';
import TenantInvitationRepository from './database/repositories/tenantInvitationRepository';
import { setInterval as nodeSetInterval } from 'timers';

// const PORT = process.env.PORT || 8080
const PORT = process.env.PORT || 3001

const tenantMode = process.env.TENANT_MODE || 'multi';
console.log(`TENANT_MODE: ${tenantMode}`);

api.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})

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

