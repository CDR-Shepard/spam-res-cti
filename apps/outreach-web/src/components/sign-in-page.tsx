import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { getAuthProviders, outreachKeys } from '@/lib/outreach-api';

/** Keyed by the `error` reason outreach-api's sign-in callbacks redirect with (routes/auth.ts, routes/auth-salesforce.ts) plus the web's own `handoff_failed`. */
const MESSAGES: Record<string, string> = {
  no_tenant: 'This Salesforce org is not set up for Outreach. Contact your administrator.',
  no_account: 'Your Salesforce user is not set up in the CTI yet. Sign in to the CTI softphone once, or ask an admin to add you.',
  org_not_allowed: 'This Salesforce org is not allowed to use Outreach.',
  salesforce_unavailable: 'Salesforce did not answer. Try again in a minute.',
  tenant_suspended: 'This workspace is suspended. Contact support.',
  invalid_code: 'That sign-in link expired. Try again.',
  bad_state: 'That sign-in attempt expired or was started in another tab. Try again.',
  bad_return_to: 'That link pointed somewhere this app cannot take you. Continue to sign in as usual.',
  missing_code: 'The sign-in provider did not return a code. Try again.',
  access_denied: 'Sign-in was cancelled.',
  handoff_failed: 'We could not finish signing you in. Try again.',
  forbidden: 'This account cannot sign in.',
  sign_in_disabled: 'Sign-in is not configured on this server. Contact support.',
  server_error: 'Something went wrong on our side. Try again in a minute.',
};
const FALLBACK_MESSAGE = 'Sign-in failed. Try again.';

/** `error` comes straight from the URL, so only own keys count: `?error=constructor` must not resolve to `Object.prototype.constructor`. */
function messageFor(error: string): string {
  if (!Object.hasOwn(MESSAGES, error)) return FALLBACK_MESSAGE;
  return MESSAGES[error] ?? FALLBACK_MESSAGE;
}

export function SignInPage({ error, returnTo }: { error?: string; returnTo?: string }) {
  const auth = useAuth();
  const providers = useQuery({ queryKey: outreachKeys.authProviders, queryFn: getAuthProviders, retry: false });
  // While loading, or if the request fails, Salesforce is the default: the server answers sign_in_disabled if it is off.
  const salesforce = providers.data?.salesforce ?? true;
  const workos = providers.data?.workos ?? false;
  const nothingConfigured = providers.isSuccess && !salesforce && !workos;
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,rgb(228_242_34/0.22),transparent_70%)]" />
      <div className="relative w-full max-w-[380px] space-y-6">
        <div aria-hidden className="flex justify-center">
          <span className="grid size-10 place-items-center rounded-[11px] bg-brand shadow-[inset_0_0_0_1px_rgb(15_15_14/0.08)]">
            <span className="h-4 w-1.5 -skew-x-12 rounded-[2px] bg-brand-foreground" />
          </span>
        </div>
        <Card className="shadow-[0_1px_2px_rgb(15_15_14/0.04),0_12px_32px_-12px_rgb(15_15_14/0.12)]">
          <CardHeader className="border-b-0 pt-7 pb-1 text-center">
            <CardTitle className="text-[22px] tracking-[-0.02em]">Outreach</CardTitle>
            <CardDescription className="mx-auto">Sign in with your Salesforce account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-5 pb-7">
            {error && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-destructive">{messageFor(error)}</p>}
            {nothingConfigured && error !== 'sign_in_disabled' && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-destructive">{MESSAGES.sign_in_disabled}</p>}
            {salesforce && <Button className="h-10 w-full" onClick={() => auth.startSignIn(returnTo, 'salesforce')}>Sign in with Salesforce</Button>}
            {workos && (
              <Button className="h-10 w-full" variant={salesforce ? 'outline' : 'default'} onClick={() => auth.startSignIn(returnTo, 'workos')}>
                Sign in with email
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
