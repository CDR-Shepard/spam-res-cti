import { useQuery } from '@tanstack/react-query';
import type { WritebackReadiness, WritebackReadinessProblem } from '@cti/contracts';
import { outreachKeys, writebackReadiness } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

type Item = WritebackReadiness['items'][number];

const PROBLEM_WORDS: Readonly<Record<WritebackReadinessProblem, string>> = {
  not_updateable: "the connected Salesforce user can't edit it",
  missing: 'not in this Salesforce org, or hidden from the connected user',
  cannot_create: "can't be created by the connected user",
  cannot_convert: "the connected Salesforce user doesn't have it",
  soap_unavailable: "Salesforce's SOAP API refuses the connection",
};

/** "Lead · AI Last Call Changes: …" for a field; "Event: …" for an object or a permission. */
export const itemWords = (i: Item): string => `${i.field ? `${i.object} · ${i.label}` : i.label}: ${PROBLEM_WORDS[i.problem]}`;

const CONVERT_OBJECTS: ReadonlySet<string> = new Set(['Account', 'Contact', 'Opportunity']);
/** What stops a conversion (task 27's convert items): SOAP, the permission, or Account/Contact/Opportunity not createable. */
const isConvertItem = (i: Item): boolean =>
  i.problem === 'soap_unavailable' || i.problem === 'cannot_convert' || (i.problem === 'cannot_create' && CONVERT_OBJECTS.has(i.object));

function conversionWords(r: WritebackReadiness): string {
  if (r.convertReady) {
    return `Lead conversion: ready. New records will be ${r.convertRecordTypes.account ?? 'the default Account'} / ${r.convertRecordTypes.opportunity ?? 'the default Opportunity'}`;
  }
  const why = r.items.filter(isConvertItem).map(itemWords).join('; ') || 'Salesforce did not say why';
  return `Lead conversion: not ready (${why}). A Lead that books gets a calendar hold and a Task instead`;
}

/**
 * "Salesforce write-back readiness" (plan 1D, admins): can the connected Salesforce user write call results back and convert a
 * Lead that books, who appointments go to, and what a conversion creates. Read-only; reading it again re-checks.
 */
export function WritebackReadinessSection() {
  const readiness = useQuery({ queryKey: outreachKeys.writebackReadiness, queryFn: writebackReadiness });
  const r = readiness.data;
  const problems = r ? r.items.filter((i) => !isConvertItem(i)) : [];
  return (
    <section className="space-y-2 border-t pt-5 text-sm leading-6">
      <h3 className="text-[13px] font-semibold">Salesforce write-back readiness</h3>
      {readiness.isPending && <p className="text-muted-foreground">Checking Salesforce…</p>}
      {readiness.error && <p className="text-destructive">{errorText(readiness.error)}</p>}
      {r && problems.length === 0 && <p>{r.ready ? 'Ready' : 'Not ready'}</p>}
      {r && problems.length > 0 && (
        <>
          <p>{r.ready ? 'Ready, but these are skipped:' : 'Not ready:'}</p>
          <ul aria-label="Write-back problems" className="list-disc pl-5 text-destructive">
            {problems.map((i) => <li key={`${i.object}:${i.field ?? i.label}`}>{itemWords(i)}</li>)}
          </ul>
        </>
      )}
      {r && <p>{`Appointments go to: ${r.appointmentOwner?.name ?? 'nobody active: booking is off'}`}</p>}
      {r && <p>{conversionWords(r)}</p>}
    </section>
  );
}
