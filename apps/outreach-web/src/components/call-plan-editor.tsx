import { useState } from 'react';
import { EditableCallPlan, PreferredWindow, QUALIFICATION_TOPICS, type CallGoal, type QualificationTopic } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EVIDENCE_WORDS, GOAL_WORDS, STRENGTH_WORDS, TOPIC_WORDS, WINDOW_WORDS } from '@/lib/call-words';

/** One item per line; blank lines dropped. */
const toLines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean);
const fromLines = (items: readonly string[]): string => items.join('\n');

interface Draft {
  situationSummary: string;
  opener: string;
  goals: Array<{ goal: CallGoal['goal']; known: string; approach: string }>;
  talkingPoints: string;
  questions: string;
  avoid: string;
  window: PreferredWindow;
  windowReason: string;
  /** Plan 1D: what the last contact was about; the contact's own words are computed and read-only. */
  lastTopic: string;
  stillToLearn: QualificationTopic[];
}

const draftOf = (p: EditableCallPlan): Draft => ({
  situationSummary: p.situationSummary,
  opener: p.opener,
  goals: p.goals.map((g) => ({ goal: g.goal, known: g.known ?? '', approach: g.approach })),
  talkingPoints: fromLines(p.talkingPoints),
  questions: fromLines(p.questions),
  avoid: fromLines(p.avoid),
  window: p.bestTimeToCall.window,
  windowReason: p.bestTimeToCall.reason,
  lastTopic: p.reengagement?.lastTopic ?? '',
  stillToLearn: p.stillToLearn,
});

/**
 * The draft as a plan; selling signals are the model's reading of the evidence and are carried over untouched.
 * Re-engagement stays null when there was no contact; its computed words are the original's (the server keeps them too).
 */
const planOf = (d: Draft, original: EditableCallPlan): unknown => ({
  situationSummary: d.situationSummary,
  sellingSignals: original.sellingSignals,
  opener: d.opener,
  goals: d.goals.map((g) => ({ goal: g.goal, known: g.known.trim() === '' ? null : g.known, approach: g.approach })),
  talkingPoints: toLines(d.talkingPoints),
  questions: toLines(d.questions),
  avoid: toLines(d.avoid),
  bestTimeToCall: { window: d.window, reason: d.windowReason },
  reengagement: original.reengagement ? { lastContact: original.reengagement.lastContact, lastTopic: d.lastTopic.trim() === '' ? null : d.lastTopic } : null,
  stillToLearn: QUALIFICATION_TOPICS.filter((t) => d.stillToLearn.includes(t)),
});

export function CallPlanEditor({ plan, onSave, onCancel, busy }: { plan: EditableCallPlan; onSave: (plan: EditableCallPlan) => void; onCancel: () => void; busy: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(plan));
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggleTopic = (t: QualificationTopic, on: boolean) =>
    setDraft((d) => ({ ...d, stillToLearn: on ? [...d.stillToLearn.filter((x) => x !== t), t] : d.stillToLearn.filter((x) => x !== t) }));
  const setGoal = (i: number, patch: Partial<Draft['goals'][number]>) => setDraft((d) => ({ ...d, goals: d.goals.map((g, j) => (j === i ? { ...g, ...patch } : g)) }));

  function save() {
    const parsed = EditableCallPlan.safeParse(planOf(draft, plan));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setProblem(issue ? `${issue.path.join(' › ')}: ${issue.message}` : 'Check the plan and try again.');
      return;
    }
    setProblem(null);
    onSave(parsed.data);
  }

  return (
    <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="Situation summary"><Textarea value={draft.situationSummary} onChange={(e) => set('situationSummary', e.target.value)} /></Field>
      {plan.sellingSignals.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-label="Selling signals (read-only)">
          {plan.sellingSignals.map((s, i) => <li key={i}>{s.signal} ({STRENGTH_WORDS[s.strength]}, {EVIDENCE_WORDS[s.source]})</li>)}
        </ul>
      )}
      <Field label="Opener"><Input value={draft.opener} onChange={(e) => set('opener', e.target.value)} /></Field>
      {plan.reengagement?.lastContact && <p className="text-sm text-muted-foreground">Last real contact: {plan.reengagement.lastContact}</p>}
      {plan.reengagement && <Field label="What we last talked about"><Input maxLength={200} value={draft.lastTopic} onChange={(e) => set('lastTopic', e.target.value)} /></Field>}
      <fieldset className="rounded-md border p-2">
        <legend className="px-1 text-sm font-medium">Still to learn</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {QUALIFICATION_TOPICS.map((t) => (
            <label key={t} className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={draft.stillToLearn.includes(t)} onChange={(e) => toggleTopic(t, e.target.checked)} />
              {TOPIC_WORDS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      {draft.goals.map((g, i) => (
        <fieldset key={g.goal} className="space-y-2 rounded-md border p-2">
          <legend className="px-1 text-sm font-medium">{GOAL_WORDS[g.goal]}</legend>
          <Field label={`Known: ${GOAL_WORDS[g.goal]}`}><Input value={g.known} onChange={(e) => setGoal(i, { known: e.target.value })} /></Field>
          <Field label={`How to ask: ${GOAL_WORDS[g.goal]}`}><Input value={g.approach} onChange={(e) => setGoal(i, { approach: e.target.value })} /></Field>
        </fieldset>
      ))}
      <Field label="Talking points (one per line)"><Textarea value={draft.talkingPoints} onChange={(e) => set('talkingPoints', e.target.value)} /></Field>
      <Field label="Questions (one per line)"><Textarea value={draft.questions} onChange={(e) => set('questions', e.target.value)} /></Field>
      <Field label="Avoid (one per line)"><Textarea value={draft.avoid} onChange={(e) => set('avoid', e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Best time to call">
          <select className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={draft.window} onChange={(e) => set('window', PreferredWindow.parse(e.target.value))}>
            {PreferredWindow.options.map((w) => <option key={w} value={w}>{WINDOW_WORDS[w]}</option>)}
          </select>
        </Field>
        <Field label="Why that time"><Input value={draft.windowReason} onChange={(e) => set('windowReason', e.target.value)} /></Field>
      </div>
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>Save changes</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <Label className="flex-col items-stretch gap-1">{label}{children}</Label>;
}
