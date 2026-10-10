/**
 * Real buyer questions, through the real engine and the real model.
 *
 *   yarn chat:eval                 # every scenario
 *   yarn chat:eval refund          # only scenarios whose name contains "refund"
 *
 * Reads OPENAI_API_KEY (and OPENAI_MODEL, if set) from the environment or .env. The
 * catalogue, areas and orders are the fixed sample in the harness — nothing touches the
 * database, and no buyer sees anything. Each run costs a few cents of model usage.
 *
 * The same questions run without a model in buyer-questions.spec.ts, on every test run.
 */
import { config } from 'dotenv';
import { Logger } from '@nestjs/common';
import { converse } from '../src/chat/engine/buyer-questions/harness';
import { SCENARIOS, check } from '../src/chat/engine/buyer-questions/scenarios';

config();
Logger.overrideLogger(['error']);

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set — nothing to evaluate.');
    process.exit(2);
  }
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const filter = process.argv[2]?.toLowerCase();
  const scenarios = SCENARIOS.filter(
    (scenario) => !filter || scenario.name.toLowerCase().includes(filter),
  );

  console.log(`James on ${model} — ${scenarios.length} conversations\n`);
  let failed = 0;

  for (const scenario of scenarios) {
    const run = await converse(scenario.buyer, {
      apiKey,
      model,
      setup: scenario.setup,
    });
    const problems = check(scenario, run, 'model');
    if (problems.length) failed++;

    console.log(`${problems.length ? '✗' : '✓'} ${scenario.name}`);
    for (const turn of run.turns) {
      console.log(`    buyer: ${turn.buyer}`);
      for (const reply of turn.replies) {
        const card = reply.payload ? `  [${reply.payload.kind}]` : '';
        console.log(`    james: ${reply.text}${card}`);
      }
    }
    for (const problem of problems) console.log(`    ! ${problem}`);
    console.log();
  }

  console.log(
    failed
      ? `${failed} of ${scenarios.length} conversations need attention.`
      : `All ${scenarios.length} conversations passed.`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
