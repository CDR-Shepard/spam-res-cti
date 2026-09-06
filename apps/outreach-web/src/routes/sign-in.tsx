import { createFileRoute } from '@tanstack/react-router';
import { isSafeReturnTo } from '@cti/contracts';
import { z } from 'zod';
import { SignInPage } from '@/components/sign-in-page';

// `returnTo` is attacker-controlled (it round-trips through the URL). An
// invalid value is stripped (not a hard error) so a malformed/adversarial
// link still lands on a working sign-in page with a plain "Continue" — see
// routes.test.tsx for the host-confusion cases this guards against.
export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({
    error: z.string().optional(),
    returnTo: z.string().refine(isSafeReturnTo).optional().catch(undefined),
  }),
  component: () => { const { error, returnTo } = Route.useSearch(); return <SignInPage error={error} returnTo={returnTo} />; },
});
