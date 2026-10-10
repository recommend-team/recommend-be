import { Logger } from '@nestjs/common';
import { converse } from './harness';
import { SCENARIOS, check } from './scenarios';

/**
 * Real buyer questions, through the real engine, on the keyword fallback — what every
 * buyer gets when the model is down. The same questions run against the model with
 * `yarn chat:eval`.
 */
describe('real buyer questions, without a model', () => {
  beforeAll(() => {
    // "OPENAI_API_KEY is not set" once per conversation is expected here.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const run = await converse(scenario.buyer, { setup: scenario.setup });

      expect(check(scenario, run, 'fallback')).toEqual([]);
    },
  );
});
