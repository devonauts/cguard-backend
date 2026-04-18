const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'api', 'documentation', 'openapi.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const check = [
  '/tenant/{tenantId}/post-site/{id}/assign-guard',
  '/tenant/{tenantId}/post-site/{id}/notes',
  '/tenant/{tenantId}/post-site/{id}/notes/{noteId}',
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
