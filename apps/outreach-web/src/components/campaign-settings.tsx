import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { UpdateCampaignRequest, type Campaign } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { outreachKeys, updateCampaign } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

/** "0, 1, 3" or "0 1 3" → [0, 1, 3]; anything non-numeric becomes NaN and fails validation. */
export function parseTouchDays(text: string): number[] {
  return text.split(/[\s,]+/).filter(Boolean).map(Number);
}

const REFRESH_PROBLEM = 'Refresh must be a whole number of minutes from 60 to 1,440.';
const TOUCH_DAYS_PROBLEM = 'Touch days must start at 0 and go up, like 0, 1, 3, 6, 10, 14 (at most 12 days, none past day 60).';

export function CampaignSettings({ campaign, canEdit }: { campaign: Campaign; canEdit: boolean }) {
  const qc = useQueryClient();
  const [refresh, setRefresh] = useState(String(campaign.refreshMinutes));
  const [days, setDays] = useState(campaign.touchDays.join(', '));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (req: UpdateCampaignRequest) => updateCampaign(campaign.id, req),
    onSuccess: (updated) => {
      qc.setQueryData(outreachKeys.campaign(updated.id), updated);
      void qc.invalidateQueries({ queryKey: outreachKeys.campaignLists });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = UpdateCampaignRequest.safeParse({ refreshMinutes: Number(refresh), touchDays: parseTouchDays(days) });
    if (!parsed.success) {
      setProblem(parsed.error.issues.some((i) => i.path[0] === 'refreshMinutes') ? REFRESH_PROBLEM : TOUCH_DAYS_PROBLEM);
      return;
    }
    setProblem(null);
    save.mutate(parsed.data);
  };
  return (
    <Card>
      <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
      <CardContent>
        {canEdit ? (
          <form className="space-y-3" onSubmit={submit}>
            <div className="flex flex-wrap gap-4">
              <div className="grid gap-1">
                <Label htmlFor="campaign-refresh">Refresh every (minutes)</Label>
                <Input id="campaign-refresh" type="number" min={60} max={1440} step={30} className="w-32" value={refresh} onChange={(e) => { save.reset(); setRefresh(e.target.value); }} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="campaign-touch-days">Touch days</Label>
                <Input id="campaign-touch-days" className="w-56" value={days} onChange={(e) => { save.reset(); setDays(e.target.value); }} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Touch days count from the day someone joins. A new day takes effect for each person's next touch.</p>
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={save.isPending}>Save settings</Button>
              {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
            </div>
            {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
            {save.error && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
          </form>
        ) : (
          <p className="text-sm">Checks Salesforce every {campaign.refreshMinutes} minutes. Touches on days {campaign.touchDays.join(', ')}.</p>
        )}
      </CardContent>
    </Card>
  );
}
