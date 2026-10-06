import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { RecordTestPage } from '@/components/record-test-page';
import { recordTestSearch } from '@/lib/record-test-words';

// Test a record (admins, plan 1E). `?id=<record test id>` opens that test.
export const Route = createFileRoute('/_authenticated/test-record')({ component: TestRecordRoute, validateSearch: recordTestSearch });

function TestRecordRoute() {
  // Validated again here: the root route has no validator, so a raw `?id=` would otherwise pass through to this match.
  const { id } = recordTestSearch(Route.useSearch());
  const navigate = useNavigate();
  return <RecordTestPage id={id ?? null} onOpen={(next) => void navigate({ to: '/test-record', search: { id: next } })} />;
}
