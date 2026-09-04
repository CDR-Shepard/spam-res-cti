import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SignInPage } from '@/components/sign-in-page';

export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({ error: z.string().optional(), returnTo: z.string().regex(/^\/(?![\/\\])[^\\\u0000-\u001f\u007f]*$/).optional() }),
  component: () => { const { error, returnTo } = Route.useSearch(); return <SignInPage error={error} returnTo={returnTo} />; },
});
