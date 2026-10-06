import { contactLabel, lastContactWordsAt, type AppointmentSlot, type CallPlan, type RecordTest } from '@cti/contracts';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { appointmentWords, EVIDENCE_WORDS, GOAL_WORDS, sourceLine, STRENGTH_WORDS, TOPIC_WORDS } from '@/lib/call-words';
import { DNC_CATEGORY_WORDS } from '@/lib/outreach-words';
import { costWords, offerNoteWords, RECORD_TEST_CONSENT_WORDS } from '@/lib/record-test-words';

const PT = 'America/Los_Angeles';
const PLAN_TEXT_LABEL = 'The plan text the agent gets';

/**
 * A ready preview's sections, in the order of spec §4.2. Consent other than "yes" and a do-not-contact flag show in red
 * (owner decision E-2) but never block a test: only the admin is rung.
 */
export function RecordTestPlan({ test }: { test: RecordTest }) {
  const plan = test.plan;
  return (
    <div className="space-y-4">
      <ConsentLines test={test} />
      {plan && (
        <>
          <DoNotContact plan={plan} />
          <Section title="Last real contact"><LastContact plan={plan} /></Section>
          <Section title="Still to learn">
            <p>{plan.stillToLearn.length > 0 ? plan.stillToLearn.map((t) => TOPIC_WORDS[t]).join(', ') : 'Nothing: the records already answer every topic.'}</p>
          </Section>
          <Section title="Opener"><p>{plan.opener}</p></Section>
          <PlanBody plan={plan} />
        </>
      )}
      <PlanText test={test} />
      <Times test={test} />
      {test.sources.length > 0 && (
        <Section title="What it read">
          <ul className="text-xs text-muted-foreground" aria-label="Research sources">{test.sources.map((s) => <li key={s.source}>{sourceLine(s)}</li>)}</ul>
        </Section>
      )}
      <p className="text-xs text-muted-foreground">{costWords(test.costMicros)}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  );
}

function ConsentLines({ test }: { test: RecordTest }) {
  if (!test.consent) return null;
  return (
    <div className="space-y-1">
      <Badge variant={test.consent === 'yes' ? 'secondary' : 'destructive'}>{RECORD_TEST_CONSENT_WORDS[test.consent]}</Badge>
      {test.consent !== 'yes' && <p className="font-medium text-destructive">A campaign would not call this person. A test only rings you.</p>}
    </div>
  );
}

function DoNotContact({ plan }: { plan: CallPlan }) {
  const dnc = plan.doNotContact;
  if (!dnc) return null;
  return (
    <p className="font-medium text-destructive">
      {`Do-not-contact flag: ${DNC_CATEGORY_WORDS[dnc.category]} — “${dnc.quote}”. A campaign would hold this lead in Needs Review.`}
    </p>
  );
}

function LastContact({ plan }: { plan: CallPlan }) {
  const r = plan.reengagement;
  const words = lastContactWordsAt(r, new Date());
  if (!words) return <p>No earlier conversation found: the agent will introduce us.</p>;
  return (
    <>
      <p>{`${contactLabel(r?.lastContactKind)}: ${words}${r?.lastTopic ? ` — ${r.lastTopic}` : ''}`}</p>
      <p className="text-muted-foreground">The agent will treat them as someone we know.</p>
    </>
  );
}

function PlanBody({ plan }: { plan: CallPlan }) {
  return (
    <>
      <Section title="Situation"><p>{plan.situationSummary}</p></Section>
      {plan.sellingSignals.length > 0 && (
        <Section title="Selling signals">
          <ul className="list-disc space-y-1 pl-5">
            {plan.sellingSignals.map((s, i) => <li key={i}>{`${s.signal}: “${s.evidence}” (${EVIDENCE_WORDS[s.source]}, ${STRENGTH_WORDS[s.strength]})`}</li>)}
          </ul>
        </Section>
      )}
      <Section title="Goals">
        <ul className="space-y-1">
          {plan.goals.map((g) => <li key={g.goal}><span className="font-medium">{GOAL_WORDS[g.goal]}</span> {g.known ?? 'Unknown'}. {g.approach}</li>)}
        </ul>
      </Section>
    </>
  );
}

function PlanText({ test }: { test: RecordTest }) {
  if (test.planText === null) {
    const words = test.planTextWords.length > 0 ? test.planTextWords.join('; ') : 'it did not pass the check';
    return <p role="alert" className="font-medium text-destructive">{`The voice agent can't be given this plan: ${words}. Regenerate it.`}</p>;
  }
  return (
    <Section title={PLAN_TEXT_LABEL}>
      <pre aria-label={PLAN_TEXT_LABEL} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">{test.planText}</pre>
    </Section>
  );
}

const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function slotWords(s: AppointmentSlot): string {
  const pt = `${appointmentWords(s, PT)} PT`;
  return viewerZone() === PT ? pt : `${pt} (${appointmentWords(s)} your time)`;
}

function Times({ test }: { test: RecordTest }) {
  if (test.slots.length === 0) return <Section title="Appointment times"><p className="text-muted-foreground">{offerNoteWords(test.offerNote)}</p></Section>;
  const who = test.slots[0]?.specialistFirstName;
  return (
    <Section title={`Times it would offer now${who ? `, with ${who}` : ''}`}>
      <ul className="space-y-0.5">{test.slots.map((s) => <li key={s.id}>{slotWords(s)}</li>)}</ul>
      <p className="text-xs text-muted-foreground">A test call reads the calendar again when it starts.</p>
    </Section>
  );
}
