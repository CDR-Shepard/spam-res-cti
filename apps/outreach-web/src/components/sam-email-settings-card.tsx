import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import type { SamEmailSettings } from '@cti/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/lib/auth';
import { getSamEmailSettings, outreachKeys, saveSamEmailSettings } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const NOT_SET_UP_WORDS = 'Resend is not set up yet';
const SAVE_ERROR_WORDS = { EMAIL_NOT_CONFIGURED: 'Email from Sam is not set up on this server yet.' } as const;

/** The pause line. A pause the server could not read (stored as the epoch) has no date to show, so it says none. */
function pausedWords(pausedAt: string): string {
  const at = Date.parse(pausedAt);
  const when = Number.isFinite(at) && at > 0 ? ` on ${new Date(at).toLocaleDateString('en-US', { dateStyle: 'medium' })}` : '';
  return `Paused after a spam complaint${when}. Turn it back on when you're ready.`;
}

/**
 * "Email from Sam" (admins): the tenant's switch for whether Sam may email sellers. It is off until the server has
 * Resend and Sam's writer set up (the switch says so, and cannot be turned on; an admin can always turn it off), and a
 * spam complaint pauses it for the whole tenant: it reads as off then, and turning it on again is the admin saying they
 * have looked into it.
 */
export function SamEmailSettingsCard() {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return null;
  return <AdminSamEmailSettings />;
}

function AdminSamEmailSettings() {
  const settings = useQuery({ queryKey: outreachKeys.samEmailSettings, queryFn: getSamEmailSettings });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email from Sam</CardTitle>
        <CardDescription>Whether Sam may email sellers at all.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {/* Not an alert: the Salesforce card's problems are the alerts on this page. */}
        {settings.error && <p className="text-sm text-destructive">{errorText(settings.error)}</p>}
        {settings.data && <EmailSwitch saved={settings.data} />}
      </CardContent>
    </Card>
  );
}

function EmailSwitch({ saved }: { saved: SamEmailSettings }) {
  const qc = useQueryClient();
  const switchId = useId();
  const hintId = useId();
  const save = useMutation({ mutationFn: saveSamEmailSettings, onSuccess: (data) => qc.setQueryData(outreachKeys.samEmailSettings, data) });
  // A paused tenant reads as off whatever `enabled` still says: nothing is sent until an admin turns it back on.
  const on = save.isPending ? save.variables : saved.enabled && saved.pausedAt === null;
  const hints = [...(saved.configured ? [] : [NOT_SET_UP_WORDS]), ...(saved.pausedAt === null ? [] : [pausedWords(saved.pausedAt)])];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Switch id={switchId} checked={on} disabled={(!saved.configured && !on) || save.isPending} aria-describedby={hints.length > 0 ? hintId : undefined} onCheckedChange={(enabled) => save.mutate(enabled)} />
        <Label htmlFor={switchId}>Email from Sam</Label>
      </div>
      {hints.length > 0 && (
        <div id={hintId} className="space-y-1 text-xs text-muted-foreground">
          {hints.map((hint) => <p key={hint}>{hint}</p>)}
        </div>
      )}
      {save.error && <p role="alert" className="text-sm text-destructive">{errorText(save.error, SAVE_ERROR_WORDS)}</p>}
    </div>
  );
}
