/**
 * RBAC coverage audit (dev tool — run via `npx ts-node src/scripts/auditPermissions.ts`).
 * NOT wired into the server. Pure static analysis, no DB required.
 *
 * Emits three buckets:
 *   DEAD             — permissions defined in permissions.ts but never referenced
 *                      as Permissions.values.<id> anywhere in src/ (candidates for
 *                      removal; review only — nothing is deleted automatically).
 *   UNGATED_MUTATION — mutation route handlers (Create/Update/Edit/Destroy/…) with
 *                      no validateHas() / enforceGate() call.
 *   UNGATED_READ     — read handlers (List/Find/Read/Autocomplete) with no gate.
 */
import fs from 'fs';
import path from 'path';
import Permissions from '../security/permissions';

const SRC = path.resolve(__dirname, '..');
const API_DIR = path.join(SRC, 'api');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const MUTATION_SUFFIXES = ['Create', 'Update', 'Edit', 'Destroy', 'Patch', 'Import', 'Restore', 'Archive', 'Send', 'Approve', 'Reset'];
const READ_SUFFIXES = ['List', 'Find', 'Read', 'Autocomplete', 'Export', 'Get'];

function classify(file: string): 'mutation' | 'read' | 'other' {
  const base = path.basename(file, '.ts');
  if (base === 'index') return 'other';
  if (MUTATION_SUFFIXES.some((s) => base.endsWith(s))) return 'mutation';
  if (READ_SUFFIXES.some((s) => base.endsWith(s))) return 'read';
  return 'other';
}

function main() {
  const defined = Object.keys(Permissions.values);

  // Enforced/referenced permission ids across the whole src tree.
  const allFiles = walk(SRC);
  const referenced = new Set<string>();
  const re = /Permissions\.values\.([A-Za-z0-9_]+)/g;
  for (const f of allFiles) {
    const txt = fs.readFileSync(f, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) referenced.add(m[1]);
  }

  const dead = defined.filter((id) => !referenced.has(id)).sort();

  // Ungated handlers.
  const handlerFiles = walk(API_DIR);
  const ungatedMutation: string[] = [];
  const ungatedRead: string[] = [];
  for (const f of handlerFiles) {
    const kind = classify(f);
    if (kind === 'other') continue;
    const txt = fs.readFileSync(f, 'utf8');
    const gated = txt.includes('validateHas') || txt.includes('enforceGate');
    if (gated) continue;
    const rel = path.relative(SRC, f);
    if (kind === 'mutation') ungatedMutation.push(rel);
    else ungatedRead.push(rel);
  }

  const out = {
    summary: {
      definedPermissions: defined.length,
      referencedPermissions: referenced.size,
      dead: dead.length,
      ungatedMutations: ungatedMutation.length,
      ungatedReads: ungatedRead.length,
    },
    DEAD: dead,
    UNGATED_MUTATION: ungatedMutation.sort(),
    UNGATED_READ: ungatedRead.sort(),
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
