import { contactLabel, lastContactWordsAt, type AppointmentSlot, type CallPlan, type RecordTest } from '@cti/contracts';
import type { ReactNode } from 'react';
import { CalendarClock, Circle, TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/layout/status-badge';
import { appointmentWords, EVIDENCE_WORDS, GOAL_WORDS, sourceLine, STRENGTH_WORDS, TOPIC_WORDS } from '@/lib/call-words';
import { DNC_CATEGORY_WORDS } from '@/lib/outreach-words';
import { costWords, offerNoteWords, RECORD_TEST_CONSENT_WORDS } from '@/lib/record-test-words';

const PT = 'America/Los_Angeles';
const PLAN_TEXT_LABEL = 'The plan text the agent gets';
/** The red callout consent and do-not-contact warnings sit in (owner decision E-2: they stay clearly red). */
const RED_CALLOUT = 'flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-danger-soft px-3.5 py-3';

/**
 * A ready preview's sections, in the order of spec §4.2, laid out like a document. Consent other than "yes" and a
 * do-not-contact flag show in red (owner decision E-2) but never block a test: only the admin is rung.
 */
export function RecordTestPlan({ test }: { test: RecordTest }) {
  const plan = test.plan;
  return (
    <div className="space-y-6">
      <ConsentLines test={test} />
      {plan && (
        <>
          <DoNotContact plan={plan} />
          <div className="grid gap-6 sm:grid-cols-2">
            <Section title="Last real contact"><LastContact plan={plan} /></Section>
            <Section title="Still to learn"><StillToLearn plan={plan} /></Section>
          </div>
          <Section title="Opener">
            <blockquote className="border-l-[3px] border-brand pl-4 text-[15px] leading-7 text-foreground">{plan.opener}</blockquote>
          </Section>
          <PlanBody plan={plan} />
        </>
      )}
      <PlanText test={test} />
      <Times test={test} />
      {test.sources.length > 0 && (
        <Section title="What it read">
          <ul className="space-y-1 text-xs leading-5 text-muted-foreground" aria-label="Research sources">{test.sources.map((s) => <li key={s.source}>{sourceLine(s)}</li>)}</ul>
        </Section>
      )}
      <p className="border-t pt-4 text-xs text-muted-foreground tabular-nums">{costWords(test.costMicros)}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="eyebrow">{title}</h3>
      <div className="leading-6">{children}</div>
    </section>
  );
}

function ConsentLines({ test }: { test: RecordTest }) {
  if (!test.consent) return null;
  if (test.consent === 'yes') return <StatusBadge tone="success">{RECORD_TEST_CONSENT_WORDS[test.consent]}</StatusBadge>;
  return (
    <div className={RED_CALLOUT}>
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="space-y-1.5">
        <StatusBadge tone="danger" className="bg-card">{RECORD_TEST_CONSENT_WORDS[test.consent]}</StatusBadge>
        <p className="font-medium text-destructive">A campaign would not call this person. A test only rings you.</p>
      </div>
    </div>
  );
}

function DoNotContact({ plan }: { plan: CallPlan }) {
  const dnc = plan.doNotContact;
  if (!dnc) return null;
  return (
    <div className={RED_CALLOUT}>
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="font-medium text-destructive">
        {`Do-not-contact flag: ${DNC_CATEGORY_WORDS[dnc.category]} — “${dnc.quote}”. A campaign would hold this lead in Needs Review.`}
      </p>
    </div>
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

/** What the call should find out, as a checklist (nothing is ticked: the call has not happened yet). */
function StillToLearn({ plan }: { plan: CallPlan }) {
  if (plan.stillToLearn.length === 0) return <p>Nothing: the records already answer every topic.</p>;
  return (
    <ul aria-label="Still to learn" className="space-y-1.5">
      {plan.stillToLearn.map((t) => (
        <li key={t} className="flex items-center gap-2.5">
          <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
          {TOPIC_WORDS[t]}
        </li>
      ))}
    </ul>
  );
}

function PlanBody({ plan }: { plan: CallPlan }) {
  return (
    <>
      <Section title="Situation"><p>{plan.situationSummary}</p></Section>
      {plan.sellingSignals.length > 0 && (
        <Section title="Selling signals">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground/60">
            {plan.sellingSignals.map((s, i) => <li key={i}>{`${s.signal}: “${s.evidence}” (${EVIDENCE_WORDS[s.source]}, ${STRENGTH_WORDS[s.strength]})`}</li>)}
          </ul>
        </Section>
      )}
      <Section title="Goals">
        <ul className="divide-y rounded-lg border">
          {plan.goals.map((g) => <li key={g.goal} className="px-3.5 py-2.5"><span className="font-medium">{GOAL_WORDS[g.goal]}</span> {g.known ?? 'Unknown'}. {g.approach}</li>)}
        </ul>
      </Section>
    </>
  );
}

function PlanText({ test }: { test: RecordTest }) {
  if (test.planText === null) {
    const words = test.planTextWords.length > 0 ? test.planTextWords.join('; ') : 'it did not pass the check';
    return (
      <div className={RED_CALLOUT}>
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <p role="alert" className="font-medium text-destructive">{`The voice agent can't be given this plan: ${words}. Regenerate it.`}</p>
      </div>
    );
  }
  return (
    <Section title={PLAN_TEXT_LABEL}>
      <pre aria-label={PLAN_TEXT_LABEL} className="max-h-96 overflow-auto rounded-lg border bg-muted/60 p-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap">{test.planText}</pre>
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
      <ul className="flex flex-wrap gap-2">
        {test.slots.map((s) => (
          <li key={s.id} className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-[13px] tabular-nums">
            <CalendarClock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {slotWords(s)}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">A test call reads the calendar again when it starts.</p>
    </Section>
  );
}
