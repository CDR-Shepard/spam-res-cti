import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { AiCallSettings, type SalesforceUserOption } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { getAiCallSettings, outreachKeys, salesforceUsersById, saveAiCallSettings } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { core, NobodyActive, OwnerList, UserSearch } from './appointment-owners';
import { WritebackReadinessSection } from './writeback-readiness';

type Booking = AiCallSettings['booking'];
type Kind = 'phone' | 'walkthrough';
type KindRules = Booking['phone'];

const KIND_TITLES: Readonly<Record<Kind, { offer: string; noun: string }>> = {
  phone: { offer: 'Offer phone calls', noun: 'Phone call' },
  walkthrough: { offer: 'Offer walkthroughs', noun: 'Walkthrough' },
};
const OWNER_LINE = 'Every AI-booked appointment goes to the first active person on this list. They distribute them.';
/** Final review WEB I-2: the switches below default off, and are tenant-wide. */
const START_OFF_WORDS =
  'Booking, Lead conversion and Salesforce write-back start off for every tenant, and these switches apply to every AI call campaign. Turn them on only after the readiness check below says Ready, a practice call sounds right, and a one-Lead live check was written back correctly.';
/** Fix 2: a time the agent offers must reach Salesforce, so booking needs write-back. */
const NEEDS_WRITEBACK_WORDS = 'Turn on Salesforce write-back first';
const INVALID_WORDS = 'Check the numbers: each kind needs an end hour after its start hour, and every value in range.';
const MAX_OWNERS = 20;

/**
 * "AI calls" (admins): who AI-booked appointments go to, the hours each kind may be booked in, Lead conversion, and the
 * Salesforce write-back switch. The server keeps everything else in the tenant's settings as it was.
 */
export function AiCallSettingsCard() {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return null;
  return <AdminAiCallSettings />;
}

function AdminAiCallSettings() {
  const settings = useQuery({ queryKey: outreachKeys.aiCallSettings, queryFn: getAiCallSettings });
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI calls</CardTitle>
        <CardDescription>Appointments the AI agent may book, and what it writes back to Salesforce after a call.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {settings.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {/* Not an alert: the Salesforce card's problems are the alerts on this page. */}
        {settings.error && <p className="text-sm text-destructive">{errorText(settings.error)}</p>}
        {settings.data && <SettingsForm saved={settings.data} />}
        <WritebackReadinessSection />
      </CardContent>
    </Card>
  );
}

function SettingsForm({ saved }: { saved: AiCallSettings }) {
  const qc = useQueryClient();
  // Booking reads as off while write-back is off (an older blob may say otherwise): the form never starts in a state the server refuses.
  const [draft, setDraft] = useState<AiCallSettings>(() => ({ ...saved, booking: { ...saved.booking, enabled: saved.booking.enabled && saved.writeback } }));
  // The people the saved list names are resolved once; anyone added from a search is already known.
  const [savedIds] = useState(saved.booking.specialists);
  const [added, setAdded] = useState<SalesforceUserOption[]>([]);
  const resolved = useQuery({ queryKey: outreachKeys.salesforceUsersById(savedIds), queryFn: () => salesforceUsersById(savedIds), enabled: savedIds.length > 0 });
  const save = useMutation({ mutationFn: saveAiCallSettings, onSuccess: (data) => qc.setQueryData(outreachKeys.aiCallSettings, data) });
  const known = new Map([...(resolved.data ?? []), ...added].map((u) => [core(u.id), u]));
  // M-3: saved ids the lookup answered without: not (or no longer) Salesforce users. Unknown until the lookup succeeds.
  const notFound = new Set(resolved.isSuccess ? savedIds.map(core).filter((id) => !known.has(id)) : []);
  const valid = AiCallSettings.safeParse(draft).success;
  const setBooking = (patch: Partial<Booking>) => setDraft((d) => ({ ...d, booking: { ...d.booking, ...patch } }));
  const setKind = (kind: Kind, patch: Partial<KindRules>) => setDraft((d) => ({ ...d, booking: { ...d.booking, [kind]: { ...d.booking[kind], ...patch } } }));
  const add = (u: SalesforceUserOption) => {
    setAdded((a) => [...a, u]);
    setBooking({ specialists: [...draft.booking.specialists, u.id] });
  };
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(draft);
      }}
    >
      <p className="text-sm text-muted-foreground">{START_OFF_WORDS}</p>
      <Check
        label="Book appointments on AI calls"
        checked={draft.booking.enabled}
        disabled={!draft.writeback}
        onChange={(enabled) => setBooking({ enabled })}
        hint={draft.writeback ? undefined : NEEDS_WRITEBACK_WORDS}
      />
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Appointments go to</h3>
        <OwnerList
          ids={draft.booking.specialists}
          known={known}
          notFound={notFound}
          onChange={(specialists) => setBooking({ specialists })}
        />
        <NobodyActive ids={draft.booking.specialists} known={known} notFound={notFound} />
        {resolved.error && <p className="text-sm text-destructive">{errorText(resolved.error)}</p>}
        <p className="text-xs text-muted-foreground">{OWNER_LINE}</p>
        <UserSearch exclude={new Set(draft.booking.specialists.map(core))} full={draft.booking.specialists.length >= MAX_OWNERS} onAdd={add} />
      </section>
      <Check
        label="Convert a Lead that books an appointment"
        checked={draft.booking.convertLeads}
        onChange={(convertLeads) => setBooking({ convertLeads })}
        hint="Off: every Lead booking is kept on the Lead with a hold and a Task for the appointment owner."
      />
      <div className="grid gap-5 md:grid-cols-2">
        {(['phone', 'walkthrough'] as const).map((kind) => (
          <KindFields key={kind} kind={kind} value={draft.booking[kind]} onChange={(patch) => setKind(kind, patch)} />
        ))}
      </div>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Salesforce write-back</h3>
        <Check
          label="Write call results back to Salesforce"
          checked={draft.writeback}
          onChange={(writeback) => setDraft((d) => ({ ...d, writeback, booking: { ...d.booking, enabled: d.booking.enabled && writeback } }))}
        />
      </section>
      {!valid && <p className="text-sm text-destructive">{INVALID_WORDS}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!valid || save.isPending}>Save AI call settings</Button>
        {/* Only while the form still holds what was saved: every edit makes a new draft (final review m8). */}
        {save.isSuccess && !save.isPending && save.variables === draft && <p role="status" className="text-sm">Saved.</p>}
      </div>
      {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
    </form>
  );
}

function Check({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  const hintId = useId();
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint && <p id={hintId} className="pl-6 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
    </label>
  );
}

function KindFields({ kind, value, onChange }: { kind: Kind; value: KindRules; onChange: (patch: Partial<KindRules>) => void }) {
  const { offer, noun } = KIND_TITLES[kind];
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{noun}s</legend>
      <Check label={offer} checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />
      <div className="grid grid-cols-2 gap-3">
        <NumberField label={`${noun} length (minutes)`} value={value.durationMinutes} min={10} max={180} onChange={(durationMinutes) => onChange({ durationMinutes })} />
        <span />
        <NumberField label={`${noun} from (hour, 24h)`} value={value.startHour} min={6} max={20} onChange={(startHour) => onChange({ startHour })} />
        <NumberField label={`${noun} until (hour, 24h)`} value={value.endHour} min={7} max={22} onChange={(endHour) => onChange({ endHour })} />
        <NumberField
          label={`${noun} earliest (hours ahead)`}
          value={value.minLeadMinutes / 60}
          min={0}
          max={168}
          step={0.5}
          onChange={(hours) => onChange({ minLeadMinutes: Math.round(hours * 60) })}
        />
        <NumberField
          label={`${noun} latest (business days ahead)`}
          value={value.horizonBusinessDays}
          min={1}
          max={10}
          onChange={(horizonBusinessDays) => onChange({ horizonBusinessDays })}
        />
      </div>
    </fieldset>
  );
}
