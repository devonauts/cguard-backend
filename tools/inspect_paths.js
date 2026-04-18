const fs = require('fs');
const p = require('path');
const file = p.join(__dirname, '..', 'src', 'api', 'documentation', 'openapi.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const check = [
  '/auth/sign-in',
  '/auth/sign-up',
  '/auth/send-password-reset-email',
  '/auth/send-email-address-verification-email',
  '/auth/verify-email',
  '/auth/change-email',
  '/auth/change-password',
  '/auth/profile'
];
for (const pth of check) {
  const entry = j.paths[pth];
  console.log('\nPATH:', pth);
  if (!entry) { console.log('  NOT FOUND'); continue; }
  for (const m of Object.keys(entry)) {
    console.log('  METHOD', m.toUpperCase());
    const op = entry[m];
    console.log('    requestBody:', JSON.stringify(op.requestBody || null, null, 2));
  }
}
