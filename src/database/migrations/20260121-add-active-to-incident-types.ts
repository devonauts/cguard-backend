// This migration was replaced by 20260121-fix-active-incidenttypes-table.ts
// Keeping a no-op wrapper to avoid accidental double runs.
console.log('No-op migration: active column handling moved to 20260121-fix-active-incidenttypes-table.ts');

module.exports = {
  up: async () => {
    console.log('No-op: active column migration merged; see 20260121-fix-active-incidenttypes-table.ts');
  },
  down: async () => {
    console.log('No-op down: nothing to revert');
  },
};
