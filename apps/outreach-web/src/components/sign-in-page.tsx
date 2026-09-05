import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/** Keyed by the `error` reason outreach-api's callback redirects with (routes/auth.ts) plus the web's own `handoff_failed`. */
const MESSAGES: Record<string, string> = {
  no_tenant: 'Your account is not a member of a workspace yet. Ask your admin for an invite.',
  tenant_suspended: 'This workspace is suspended. Contact support.',
  invalid_code: 'That sign-in link expired. Try again.',
  bad_state: 'That sign-in attempt expired or was started in another tab. Try again.',
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
  return (
    <main className="min-h-screen grid place-items-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Outreach</CardTitle>
          <CardDescription>Sign in with your work email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p role="alert" className="text-sm text-destructive">{messageFor(error)}</p>}
          <Button className="w-full" onClick={() => auth.startSignIn(returnTo)}>Continue</Button>
        </CardContent>
      </Card>
    </main>
  );
}
