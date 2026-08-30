// Vitest entry point for the Milestone 02 analyzer suite.
// The assertions live in milestone02.mjs (shared with npm test) so there is a
// single source of truth for both runners.
import { runMilestoneTwoTests } from './milestone02.mjs';

describe('milestone 02 analyzers', () => {
  it('produces real, evidence-backed results for every analyzer', async () => {
    await runMilestoneTwoTests();
  }, 60000);
});
