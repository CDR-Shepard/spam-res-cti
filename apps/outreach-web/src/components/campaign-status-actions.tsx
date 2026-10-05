import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Campaign, CampaignStatus, CampaignStatusChange } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { changeCampaignStatus, outreachKeys } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { ConfirmAction } from './confirm-action';

interface StatusAction { to: CampaignStatusChange['status']; label: string; confirm?: { title: string; description: string } }

const GO_LIVE = { title: 'Go live?', description: "Calls will start appearing in reps' Campaign calls list." };
const RESUME = { title: 'Resume and go live?', description: GO_LIVE.description };
const ARCHIVE = { title: 'Archive this campaign?', description: 'An archived campaign stops for good and cannot be restarted.' };

/**
 * The buttons each status offers. Mirrors outreach-api's `canTransition` (A7):
 * draft→dry_run|archived; dry_run→active|paused|archived; active→paused|archived;
 * paused→active|dry_run|archived; archived→nothing. A campaign paused out of its
 * dry run offers `PAUSED_FROM_DRY_RUN` instead (see `actionsFor`).
 */
export const STATUS_ACTIONS: Record<CampaignStatus, readonly StatusAction[]> = {
  draft: [{ to: 'dry_run', label: 'Start dry run' }, { to: 'archived', label: 'Archive', confirm: ARCHIVE }],
  dry_run: [{ to: 'active', label: 'Go live', confirm: GO_LIVE }, { to: 'paused', label: 'Pause' }, { to: 'archived', label: 'Archive', confirm: ARCHIVE }],
  active: [{ to: 'paused', label: 'Pause' }, { to: 'archived', label: 'Archive', confirm: ARCHIVE }],
  paused: [{ to: 'active', label: 'Resume', confirm: RESUME }, { to: 'dry_run', label: 'Start dry run' }, { to: 'archived', label: 'Archive', confirm: ARCHIVE }],
  archived: [],
};

/** Paused out of a dry run: resuming means the dry run again; going live stays a deliberate, confirmed step. */
export const PAUSED_FROM_DRY_RUN: readonly StatusAction[] = [
  { to: 'dry_run', label: 'Resume dry run' },
  { to: 'active', label: 'Go live', confirm: GO_LIVE },
  { to: 'archived', label: 'Archive', confirm: ARCHIVE },
];

export function actionsFor(campaign: Pick<Campaign, 'status' | 'pausedFrom'>): readonly StatusAction[] {
  if (campaign.status === 'paused' && campaign.pausedFrom === 'dry_run') return PAUSED_FROM_DRY_RUN;
  return STATUS_ACTIONS[campaign.status];
}

const STATUS_ERROR_WORDS = { BAD_TRANSITION: "That change isn't allowed from the campaign's current status. Reload the page and try again." };

export function CampaignStatusActions({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: (to: CampaignStatusChange['status']) => changeCampaignStatus(campaign.id, to),
    onSuccess: (updated) => {
      qc.setQueryData(outreachKeys.campaign(updated.id), updated);
      void qc.invalidateQueries({ queryKey: outreachKeys.campaignLists });
      // The plan view shows the campaign's status and touch days.
      void qc.invalidateQueries({ queryKey: outreachKeys.plan(updated.id) });
    },
  });
  const actions = actionsFor(campaign);
  if (actions.length === 0) return null;
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Change status" className="flex flex-wrap gap-2">
        {actions.map((a) =>
          a.confirm ? (
            <ConfirmAction key={a.to} label={a.label} title={a.confirm.title} description={a.confirm.description} confirmLabel={a.label} disabled={change.isPending} onConfirm={() => change.mutate(a.to)} />
          ) : (
            <Button key={a.to} size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate(a.to)}>{a.label}</Button>
          ),
        )}
      </div>
      {change.error && <p role="alert" className="text-sm text-destructive">{errorText(change.error, STATUS_ERROR_WORDS)}</p>}
    </div>
  );
}
