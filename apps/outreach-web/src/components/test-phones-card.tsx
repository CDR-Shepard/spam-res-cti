import { useQuery } from '@tanstack/react-query';
import { Section } from '@/components/layout/section';
import { getTestPhones, outreachKeys } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { TestPhoneForm } from './test-phone-form';
import { TestPhoneRow } from './test-phone-row';

const INTRO_WORDS = "Phones on this list can get test calls from the agent, and when they call one of the agent's numbers, the agent answers.";
const CONSENT_WORDS = 'Only add phones whose owners agreed to get test calls from the agent.';

/** "Test phones" (admins): the phones that can get test calls from the agent and that get the agent when they call in. */
export function TestPhonesCard() {
  const phones = useQuery({ queryKey: outreachKeys.testPhones, queryFn: getTestPhones });
  const list = phones.data?.phones ?? [];
  return (
    <Section title="Test phones" description={INTRO_WORDS} bodyClassName="space-y-5">
      <p className="text-sm font-medium">{CONSENT_WORDS}</p>
      {phones.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {phones.error && <p role="alert" className="text-sm text-destructive">{errorText(phones.error)}</p>}
      {phones.data && list.length === 0 && <p className="text-sm text-muted-foreground">No test phones yet.</p>}
      {list.length > 0 && <ul className="divide-y">{list.map((p) => <TestPhoneRow key={p.id} phone={p} />)}</ul>}
      <TestPhoneForm />
    </Section>
  );
}
