// This migration was merged into 20260121-add-fields-to-requests.ts
// Kept as a no-op to avoid issues if referenced by tooling.
module.exports = {
  up: async () => {
    console.log('No-op migration: internalNotes was merged into 20260121-add-fields-to-requests.ts');
  },
  down: async () => {
    console.log('No-op migration down: nothing to revert (merged)');
  },
};
