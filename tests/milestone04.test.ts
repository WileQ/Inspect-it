// Vitest entry point for the Milestone 04 optional-LLM suite.
// The assertions live in milestone04.mjs (shared with npm test).
import { runMilestoneFourTests } from './milestone04.mjs';

describe('milestone 04 optional LLM layer', () => {
  it('works against a mock OpenAI-compatible provider and stays local-only by default', async () => {
    await runMilestoneFourTests();
  }, 60000);
});
