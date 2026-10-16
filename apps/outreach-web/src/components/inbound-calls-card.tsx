import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Section } from '@/components/layout/section';
import { buttonVariants } from '@/components/ui/button';
import { getInboundTestCalls, outreachKeys } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { formatPhoneList } from '@/lib/testing-words';
import { InboundCallItem } from './inbound-call-item';

/** How often the list reads again while the page is open: a call a tester just made shows up without a reload. */
export const INBOUND_POLL_MS = 10_000;
const NO_NUMBER_WORDS = 'No agent number takes calls yet.';

const howToCallWords = (aiNumbers: readonly string[]): string =>
  aiNumbers.length === 0 ? NO_NUMBER_WORDS : `Call ${formatPhoneList(aiNumbers)} from a phone on the list and the agent answers with the inbound prompt.`;

/** "Inbound calls" (admins): which number to dial from a test phone, a way to the inbound prompt, and the newest inbound test calls. */
export function InboundCallsCard() {
  const inbound = useQuery({ queryKey: outreachKeys.inboundTestCalls, queryFn: getInboundTestCalls, refetchInterval: INBOUND_POLL_MS });
  const calls = inbound.data?.calls ?? [];
  return (
    <Section
      title="Inbound calls"
      description={inbound.data ? howToCallWords(inbound.data.aiNumbers) : undefined}
      actions={<Link to="/settings/agent-prompt" search={{ tab: 'inbound' }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Edit the inbound prompt</Link>}
      bodyClassName="space-y-3"
    >
      <h3 className="text-sm font-semibold">Recent inbound test calls</h3>
      {inbound.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {inbound.error && <p role="alert" className="text-sm text-destructive">{errorText(inbound.error)}</p>}
      {inbound.data && calls.length === 0 && <p className="text-sm text-muted-foreground">No inbound test calls yet.</p>}
      {calls.length > 0 && <ul className="divide-y">{calls.map((c) => <InboundCallItem key={c.id} call={c} />)}</ul>}
    </Section>
  );
}
