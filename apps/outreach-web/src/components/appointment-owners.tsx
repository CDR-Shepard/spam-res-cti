/**
 * The appointment-owner list of the "AI calls" settings card (split out of ai-call-settings.tsx, P6 M-11): the ordered
 * owners with their state, the "booking is off" line when nobody on it is active, and the Salesforce user search.
 */
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { SalesforceUserOption } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { searchSalesforceUsers } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const BOOKING_OFF = 'Booking is off: nobody active on the list';

/** Salesforce compares ids on their case-sensitive 15-character core. */
export const core = (id: string): string => id.slice(0, 15);

interface OwnerListProps {
  ids: string[];
  known: ReadonlyMap<string, SalesforceUserOption>;
  /** Cores of saved ids the lookup did not return: shown "(not found)", and never an owner. */
  notFound: ReadonlySet<string>;
  onChange: (ids: string[]) => void;
}

/** How a listed id reads: its name, or the id itself, with "(inactive)" or "(not found)" in red when it can't own appointments. */
function ownerLabel(id: string, known: ReadonlyMap<string, SalesforceUserOption>, notFound: ReadonlySet<string>): { name: string; text: string; flagged: boolean } {
  const u = known.get(core(id));
  if (u) return { name: u.name, text: u.isActive ? u.name : `${u.name} (inactive)`, flagged: !u.isActive };
  return notFound.has(core(id)) ? { name: id, text: `${id} (not found)`, flagged: true } : { name: id, text: id, flagged: false };
}

export function OwnerList({ ids, known, notFound, onChange }: OwnerListProps) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  if (ids.length === 0) return <p className="text-sm text-muted-foreground">Nobody yet. Find someone below.</p>;
  return (
    <ol aria-label="Appointment owners" className="space-y-1">
      {ids.map((id, i) => {
        const { name, text, flagged } = ownerLabel(id, known, notFound);
        return (
          <li key={id} className="flex items-center gap-2 rounded-lg border px-2 py-1 text-sm">
            <span className="w-5 text-muted-foreground">{i + 1}.</span>
            <span className={flagged ? 'flex-1 text-destructive' : 'flex-1'}>{text}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Move ${name} down`} disabled={i === ids.length - 1} onClick={() => move(i, 1)}>↓</Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} onClick={() => onChange(ids.filter((x) => x !== id))}>×</Button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Shown once the list is known to name nobody active: booking is then off whatever the switch says. An id the lookup did not
 * return counts as inactive (M-3); one not looked up yet (or whose lookup failed) is unknown, so the line waits.
 */
export function NobodyActive({ ids, known, notFound }: { ids: string[]; known: ReadonlyMap<string, SalesforceUserOption>; notFound: ReadonlySet<string> }) {
  const statusOf = (id: string): 'active' | 'inactive' | 'unknown' => {
    if (notFound.has(core(id))) return 'inactive';
    const u = known.get(core(id));
    if (!u) return 'unknown';
    return u.isActive ? 'active' : 'inactive';
  };
  const status = ids.map(statusOf);
  const off = ids.length === 0 || (!status.includes('unknown') && !status.includes('active'));
  return off ? <p className="text-sm font-medium text-destructive">{BOOKING_OFF}</p> : null;
}

export function UserSearch({ exclude, full, onAdd }: { exclude: ReadonlySet<string>; full: boolean; onAdd: (u: SalesforceUserOption) => void }) {
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
