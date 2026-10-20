/**
 * The booking regions on the "AI calls" settings card, read-only (the table is defined in code in this step): each region's
 * counties, reps and start times, a warning for a region with no active rep, the office every rep starts from, and a warning
 * when outreach-api has no Google Maps key.
 */
import type { RoutingReadiness } from '@cti/contracts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Region = RoutingReadiness['regions'][number];

const MAPS_MISSING = 'Google Maps key missing: no appointment times are offered until GOOGLE_MAPS_API_KEY is set on outreach-api.';

/** "09:00" → "9 AM", "13:30" → "1:30 PM", "00:00" → "12 AM". A start time is wall-clock Pacific; no date or zone math. */
function startTimeWords(time: string): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`} ${hour < 12 ? 'AM' : 'PM'}`;
}

function RepNames({ reps }: { reps: Region['reps'] }) {
  return (
    <ul className="space-y-0.5">
      {reps.map((r) => (
        <li key={r.id} className={r.isActive ? undefined : 'text-destructive'}>{r.isActive ? r.name : `${r.name} (inactive)`}</li>
      ))}
    </ul>
  );
}

const noActiveRepWords = (key: string): string => `No active rep: no ${key} times are offered.`;

export function RegionsSection({ routing }: { routing: RoutingReadiness }) {
  const unstaffed = routing.regions.filter((r) => !r.reps.some((rep) => rep.isActive));
  return (
    <section className="space-y-2">
      <div className="overflow-hidden rounded-xl border">
        <Table aria-label="Booking regions">
          <TableHeader>
            <TableRow>
              <TableHead>Region</TableHead>
              <TableHead>Counties</TableHead>
              <TableHead>Reps</TableHead>
              <TableHead>Starts (Pacific)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routing.regions.map((r) => (
              <TableRow key={r.key}>
                <th scope="row" className="h-12 px-3 py-2.5 text-left align-top font-medium whitespace-nowrap">{r.key}</th>
                <TableCell className="align-top whitespace-normal">{r.counties.join(', ')}</TableCell>
                <TableCell className="align-top"><RepNames reps={r.reps} /></TableCell>
                <TableCell className="align-top whitespace-normal">{r.startTimes.map(startTimeWords).join(', ')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {unstaffed.map((r) => <p key={r.key} className="text-sm font-medium text-destructive">{noActiveRepWords(r.key)}</p>)}
      <p className="text-xs text-muted-foreground">{`Reps start from the office: ${routing.officeAddress}.`}</p>
      {!routing.mapsConfigured && <p className="text-sm font-medium text-destructive">{MAPS_MISSING}</p>}
    </section>
  );
}
