#!/usr/bin/env node
import { processPendingJobs } from '../services/reportWorker';

(async function main() {
  try {
    console.log('Starting report job processor...');
    await processPendingJobs();
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Error processing report jobs', err);
    process.exit(1);
  }
})();
