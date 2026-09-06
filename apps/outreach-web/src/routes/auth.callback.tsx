import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { isSafeReturnTo } from '@cti/contracts';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/auth/callback')({
  // Same fail-soft treatment as `sign-in.tsx`: `returnTo` round-trips through
  // this URL too, so an invalid value is stripped rather than blocking the
  // page — the handoff still completes and just lands on `/` instead.
  validateSearch: z.object({ returnTo: z.string().refine(isSafeReturnTo).optional().catch(undefined) }),
  component: Callback,
});

function Callback() {
  const { returnTo } = Route.useSearch();
  const auth = useAuth();
  const navigate = useNavigate();
  // React 18 StrictMode intentionally double-invokes effects on mount
  // (dev only) to surface missing cleanup; completeHandoff() is a one-shot
  // token exchange that must not fire twice, so latch on a ref rather than
  // relying on the effect only running once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void auth.completeHandoff().then((ok) => {
      if (ok) window.location.replace(returnTo ?? '/');
      else void navigate({ to: '/sign-in', search: { error: 'handoff_failed', returnTo } });
    });
    // `auth.completeHandoff` (not `auth`) so this effect only re-runs if the
    // handoff function itself changes, not on every AuthProvider re-render.
  }, [auth.completeHandoff, navigate, returnTo]);
  return <p className="p-6 text-sm text-muted-foreground">Signing you in…</p>;
}
