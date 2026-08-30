// Vitest entry point for the Milestone 03 deep-analysis suite.
// The assertions live in milestone03.mjs (shared with npm test).
import { runMilestoneThreeTests } from './milestone03.mjs';

describe('milestone 03 deep analysis', () => {
  it('produces evidence-backed deep findings for every feature', async () => {
    await runMilestoneThreeTests();
  }, 120000);
});
