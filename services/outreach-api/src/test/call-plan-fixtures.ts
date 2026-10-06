/**
 * A complete, valid `CallPlan` for outreach-api tests (a copy of the contract test's
 * `validPlan`: importing a test file across packages would also run its suites).
 */
import type { CallPlan } from '@cti/contracts';

export const validPlan: CallPlan = {
  situationSummary: 'Inherited the house in 2024; told a rep in May the roof leaks and the siblings disagree about selling.',
  sellingSignals: [{ signal: 'Wanted a quick sale before winter', evidence: '"we need this done before the cold"', source: 'task', strength: 'strong' }],
  opener: 'Ask whether the family has decided what to do with the house on Oak Street.',
  goals: [
    { goal: 'still_selling', known: 'Open to selling in May', approach: 'Ask if that is still the plan' },
    { goal: 'timeline', known: null, approach: 'Ask when they would want to be done' },
    { goal: 'condition', known: 'Roof leaks', approach: 'Ask if the roof was fixed' },
    { goal: 'price_expectations', known: null, approach: 'Ask if they have a number in mind; never give one' },
  ],
  talkingPoints: ['We buy as-is, so the roof does not need fixing first'],
  questions: ['Is everyone on the title on board with selling?'],
  avoid: ['Do not mention the probate attorney by name'],
  bestTimeToCall: { window: 'evening', reason: 'Works days; picked up at 6pm last time' },
  doNotContact: null,
  reengagement: null,
  stillToLearn: [],
};
