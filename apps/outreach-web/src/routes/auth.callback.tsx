import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/auth/callback')({
  validateSearch: z.object({ returnTo: z.string().regex(/^\/(?![\/\\])[^\\\u0000-\u001f\u007f]*$/).optional() }),
  component: Callback,
});

function Callback() {
  const { returnTo } = Route.useSearch();
  const auth = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    void auth.completeHandoff().then((ok) => {
      if (ok) window.location.replace(returnTo ?? '/');
      else void navigate({ to: '/sign-in', search: { error: 'handoff_failed', returnTo } });
    });
  }, [auth, navigate, returnTo]);
  return <p className="p-6 text-sm text-muted-foreground">Signing you in…</p>;
}
