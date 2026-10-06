import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AiCallSettings, type SalesforceUserOption } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { getAiCallSettings, outreachKeys, salesforceUsersById, saveAiCallSettings, searchSalesforceUsers } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

type Booking = AiCallSettings['booking'];
type Kind = 'phone' | 'walkthrough';
type KindRules = Booking['phone'];

const KIND_TITLES: Readonly<Record<Kind, { offer: string; noun: string }>> = {
  phone: { offer: 'Offer phone calls', noun: 'Phone call' },
  walkthrough: { offer: 'Offer walkthroughs', noun: 'Walkthrough' },
};
const OWNER_LINE = 'Every AI-booked appointment goes to the first active person on this list. They distribute them.';
const BOOKING_OFF = 'Booking is off: nobody active on the list';
const INVALID_WORDS = 'Check the numbers: each kind needs an end hour after its start hour, and every value in range.';
const MAX_OWNERS = 20;

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

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
      </CardContent>
    </Card>
  );
}

function SettingsForm({ saved }: { saved: AiCallSettings }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AiCallSettings>(saved);
  // The people the saved list names are resolved once; anyone added from a search is already known.
  const [savedIds] = useState(saved.booking.specialists);
  const [added, setAdded] = useState<SalesforceUserOption[]>([]);
  const resolved = useQuery({ queryKey: outreachKeys.salesforceUsersById(savedIds), queryFn: () => salesforceUsersById(savedIds), enabled: savedIds.length > 0 });
  const save = useMutation({ mutationFn: saveAiCallSettings, onSuccess: (data) => qc.setQueryData(outreachKeys.aiCallSettings, data) });
  const known = new Map([...(resolved.data ?? []), ...added].map((u) => [core(u.id), u]));
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
      <Check label="Book appointments on AI calls" checked={draft.booking.enabled} onChange={(enabled) => setBooking({ enabled })} />
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Appointments go to</h3>
        <OwnerList
          ids={draft.booking.specialists}
          known={known}
          onChange={(specialists) => setBooking({ specialists })}
        />
        <NobodyActive ids={draft.booking.specialists} known={known} />
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
        <Check label="Write call results back to Salesforce" checked={draft.writeback} onChange={(writeback) => setDraft((d) => ({ ...d, writeback }))} />
      </section>
      {!valid && <p className="text-sm text-destructive">{INVALID_WORDS}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!valid || save.isPending}>Save AI call settings</Button>
        {save.isSuccess && !save.isPending && <p role="status" className="text-sm">Saved.</p>}
      </div>
      {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
    </form>
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint && <p className="pl-6 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function OwnerList({ ids, known, onChange }: { ids: string[]; known: ReadonlyMap<string, SalesforceUserOption>; onChange: (ids: string[]) => void }) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  if (ids.length === 0) return <p className="text-sm text-muted-foreground">Nobody yet. Find someone below.</p>;
  return (
    <ol aria-label="Appointment owners" className="space-y-1">
      {ids.map((id, i) => {
        const u = known.get(core(id));
        const name = u?.name ?? id;
        const inactive = u ? !u.isActive : false;
        return (
          <li key={id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
            <span className="w-5 text-muted-foreground">{i + 1}.</span>
            <span className={inactive ? 'flex-1 text-destructive' : 'flex-1'}>{inactive ? `${name} (inactive)` : name}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${name} down`} disabled={i === ids.length - 1} onClick={() => move(i, 1)}>↓</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} onClick={() => onChange(ids.filter((x) => x !== id))}>×</Button>
          </li>
        );
      })}
    </ol>
  );
}

/** Shown once the list is known to name nobody active: booking is then off whatever the switch says. */
function NobodyActive({ ids, known }: { ids: string[]; known: ReadonlyMap<string, SalesforceUserOption> }) {
  const users = ids.map((id) => known.get(core(id)));
  const off = ids.length === 0 || (users.every((u) => u !== undefined) && !users.some((u) => u?.isActive));
  return off ? <p className="text-sm font-medium text-destructive">{BOOKING_OFF}</p> : null;
}

function UserSearch({ exclude, full, onAdd }: { exclude: ReadonlySet<string>; full: boolean; onAdd: (u: SalesforceUserOption) => void }) {
  const [text, setText] = useState('');
  const search = useMutation({ mutationFn: searchSalesforceUsers });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (text.trim().length >= 2) search.mutate(text.trim());
  };
  const results = (search.data ?? []).filter((u) => !exclude.has(core(u.id)));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="Find a Salesforce user"
          placeholder="Name"
          maxLength={40}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(e);
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={text.trim().length < 2 || search.isPending} onClick={submit}>Search</Button>
      </div>
      {search.error && <p className="text-sm text-destructive">{errorText(search.error)}</p>}
      {search.data && results.length === 0 && <p className="text-sm text-muted-foreground">No one else found.</p>}
      {results.length > 0 && (
        <ul aria-label="Search results" className="space-y-1">
          {results.map((u) => (
            <li key={u.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{u.name}{u.title ? <span className="text-muted-foreground"> · {u.title}</span> : null}</span>
              <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => onAdd(u)}>Add {u.name}</Button>
            </li>
          ))}
        </ul>
      )}
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
