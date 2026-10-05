/**
 * Triage eval: runs every case in src/triage/eval-cases.json through the live triage
 * model and prints a pass rate. Exit 1 below EVAL_PASS_THRESHOLD, 2 without an API key.
 * Run on every prompt or model change:  npm -w services/outreach-api run eval:triage
 * Not part of `npm test` (it calls the Anthropic API and costs about one cent).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicTriageModel, costMicros } from '../src/ai/model.js';
import { caseToBundle, EVAL_PASS_THRESHOLD, EvalCases, scoreCase } from '../src/triage/eval.js';
import { buildTriagePrompt } from '../src/triage/notes.js';

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return 2;
  }
  const raw: unknown = JSON.parse(readFileSync(new URL('../src/triage/eval-cases.json', import.meta.url), 'utf8'));
  const cases = EvalCases.parse(raw);
  const model = new AnthropicTriageModel({ client: new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 }) });
  let passed = 0;
  let spentMicros = 0;
  for (const c of cases) {
    try {
      const out = await model.triage(buildTriagePrompt(caseToBundle(c), []));
      spentMicros += costMicros(out.model, out.inputTokens, out.outputTokens);
      const score = scoreCase(c, out.result);
      if (score.pass) passed += 1;
      console.log(`${score.pass ? 'PASS' : 'FAIL'}  ${c.id}  first=${score.firstChannel ?? 'none'}  dnc=${score.doNotContact ?? 'none'}`);
    } catch (err) {
      console.log(`FAIL  ${c.id}  error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rate = passed / cases.length;
  console.log(`\npass rate ${passed}/${cases.length} = ${rate.toFixed(2)} (threshold ${EVAL_PASS_THRESHOLD}); cost $${(spentMicros / 1_000_000).toFixed(4)}`);
  return rate >= EVAL_PASS_THRESHOLD ? 0 : 1;
}

process.exitCode = await main();
