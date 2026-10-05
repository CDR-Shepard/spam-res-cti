import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { CallPlanCard, EditableCallPlan } from '@cti/contracts';
import { ConfirmAction } from '@/components/confirm-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CALL_STAGE_WORDS, CONSENT_WORDS, EVIDENCE_WORDS, GOAL_WORDS, STRENGTH_WORDS, WINDOW_WORDS, sourceLine } from '@/lib/call-words';
import { approveCallPlan, editCallPlan, rejectCallPlan, researchAgain } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { CallPlanEditor } from './call-plan-editor';

/** Server codes the plan routes send (call-plans/decisions.ts), for the cases the server's own words do not cover. */
const DECISION_WORDS: Readonly<Record<string, string>> = {
  FORBIDDEN: 'Only the record owner in Salesforce or an admin can decide on this plan.',
  NOT_AI_CALL_CAMPAIGN: 'This campaign does not place AI calls.',
};

type Action = { kind: 'approve' | 'reject' | 'research' } | { kind: 'edit'; plan: EditableCallPlan };

/** Why Approve is off when no warning says so: the card has no consent reading, or the lead is held. */
function approvalNote(card: CallPlanCard): string | null {
  if (card.enrollmentStatus === 'needs_review') return 'Held in Needs Review for a do-not-contact flag; decide it there first.';
  if (card.callStage === 'review' && card.plan && card.consent === null && !card.warnings.some((w) => w.severity === 'block')) {
    return 'AI consent has not been read yet. Research again to read it.';
  }
  return null;
}

export function CallPlanCardView({ card, onChanged }: { card: CallPlanCard; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const act = useMutation({
    mutationFn: (a: Action) => {
      switch (a.kind) {
        case 'approve': return approveCallPlan(card.enrollmentId, card.plan!.version);
        case 'reject': return rejectCallPlan(card.enrollmentId);
        case 'research': return researchAgain(card.enrollmentId);
        case 'edit': return editCallPlan(card.enrollmentId, { version: card.plan!.version, plan: a.plan });
      }
    },
    onSuccess: () => { setEditing(false); onChanged(); },
    // The plan moved on under the reader (an edit, a new research): show the message and read the board again.
    onError: (err) => { if ((err as { code?: string }).code === 'PLAN_CHANGED') onChanged(); },
  });
  const blocked = card.warnings.some((w) => w.severity === 'block') || card.consent !== 'yes' || card.enrollmentStatus !== 'active';
  const p = card.plan?.plan;
  const note = approvalNote(card);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {card.recordUrl ? <a href={card.recordUrl} target="_blank" rel="noreferrer" className="hover:underline">{card.name ?? card.sfRecordId}</a> : (card.name ?? card.sfRecordId)}
          <Badge variant="outline">{CALL_STAGE_WORDS[card.callStage]}</Badge>
          {card.consent && <Badge variant={card.consent === 'yes' ? 'secondary' : 'destructive'}>{CONSENT_WORDS[card.consent]}</Badge>}
        </CardTitle>
        <CardDescription>{card.ownerName ? `Owner: ${card.ownerName}` : 'No owner'}{card.plan ? ` · plan v${card.plan.version}${card.plan.source === 'edit' ? ' (edited)' : ''}` : ''}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {card.warnings.map((w) => <p key={w.code} role={w.severity === 'block' ? 'alert' : undefined} className={w.severity === 'block' ? 'text-destructive' : 'text-muted-foreground'}>{w.words}</p>)}
        {card.plan?.dncFlagDismissed && <p role="status" className="rounded-md border p-2">{dismissalWords(card.plan)}</p>}
        {card.prepareError && <p role="alert" className="text-destructive">{card.prepareError}</p>}
        {card.callStage === 'research' && !card.prepareError && <p className="text-muted-foreground">Reading Salesforce and drafting a plan…</p>}
        {p && !editing && <PlanView plan={p} />}
        {p && editing && <CallPlanEditor plan={p} busy={act.isPending} onCancel={() => setEditing(false)} onSave={(plan) => act.mutate({ kind: 'edit', plan })} />}
        {card.research && <ul className="text-xs text-muted-foreground" aria-label="Research sources">{card.research.sources.map((s) => <li key={s.source}>{sourceLine(s)}</li>)}</ul>}
        {note && <p className="text-muted-foreground">{note}</p>}
        {act.error && <p role="alert" className="text-destructive">{errorText(act.error, DECISION_WORDS)}</p>}
        {card.mayDecide ? (
          <div className="flex flex-wrap gap-2">
            {card.callStage === 'review' && <Button size="sm" disabled={blocked || act.isPending || !card.plan || editing} onClick={() => act.mutate({ kind: 'approve' })}>Approve</Button>}
            {(card.callStage === 'review' || card.callStage === 'approved') && !editing && card.enrollmentStatus === 'active' && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => setEditing(true)}>Edit</Button>}
            {card.callStage !== 'queued' && card.enrollmentStatus === 'active' && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ kind: 'research' })}>Research again</Button>}
            {card.callStage !== 'queued' && card.enrollmentStatus === 'active' && (
              <ConfirmAction label="Reject" title="Reject this plan?" description="The lead leaves the campaign and is not called." confirmLabel="Reject and remove from campaign" destructive disabled={act.isPending} onConfirm={() => act.mutate({ kind: 'reject' })} />
            )}
          </div>
        ) : <p className="text-muted-foreground">Only the record owner or an admin can decide.</p>}
      </CardContent>
    </Card>
  );
}

/** CF-7: a flag the research raised and a person dismissed stays visible to whoever approves. */
function dismissalWords(plan: NonNullable<CallPlanCard['plan']>): string {
  const by = plan.dncFlagDismissedBy ?? 'a person';
  const on = plan.dncFlagDismissedAt ? ` on ${formatDateTime(plan.dncFlagDismissedAt)}` : '';
  return `Do-not-contact flag dismissed by ${by}${on}.`;
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="font-medium">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function PlanView({ plan }: { plan: EditableCallPlan }) {
  return (
    <div className="space-y-3">
      <p>{plan.situationSummary}</p>
      {plan.sellingSignals.length > 0 && (
        <div>
          <h4 className="font-medium">Selling signals</h4>
          <ul className="space-y-1">
            {plan.sellingSignals.map((s, i) => (
              <li key={i}>
                {s.signal} <q>{s.evidence}</q> <span className="text-xs text-muted-foreground">({EVIDENCE_WORDS[s.source]}, {STRENGTH_WORDS[s.strength]})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div><h4 className="font-medium">Opener</h4><p>{plan.opener}</p></div>
      <div>
        <h4 className="font-medium">Goals</h4>
        <ul className="space-y-1">
          {plan.goals.map((g) => <li key={g.goal}><span className="font-medium">{GOAL_WORDS[g.goal]}</span> {g.known ?? 'Unknown'}. {g.approach}</li>)}
        </ul>
      </div>
      <List title="Talking points" items={plan.talkingPoints} />
      <List title="Questions" items={plan.questions} />
      <List title="Avoid" items={plan.avoid} />
      <p><span className="font-medium">Best time:</span> {WINDOW_WORDS[plan.bestTimeToCall.window]}{plan.bestTimeToCall.reason ? `. ${plan.bestTimeToCall.reason}` : ''}</p>
    </div>
  );
}
