import { PageHeader } from '@/components/layout/page-header';
import { useAuth } from '@/lib/auth';
import { InboundCallsCard } from './inbound-calls-card';
import { TestPhonesCard } from './test-phones-card';

/**
 * Testing (admins): the list of test phones, and the inbound test calls (a listed phone that calls one of the AI agent's
 * numbers gets the agent, not a rep). Non-admins are told it is not for them.
 */
export function TestingPage() {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can use the Testing page.</p>;
  return (
    <div className="space-y-6">
      <PageHeader title="Testing" description="Try the AI phone agent without a real seller: have it call a test phone, or call it from one." />
      <TestPhonesCard />
      <InboundCallsCard />
    </div>
  );
}
