// Vitest entry point for the Milestone 05 production-readiness suite.
// The assertions live in production.mjs (shared with npm test).
import { runProductionTests } from './production.mjs';

describe('milestone 05 production readiness', () => {
  it('meets packaging, CSP, read-only, and no-secrets checks', async () => {
    await runProductionTests();
  }, 30000);
});
