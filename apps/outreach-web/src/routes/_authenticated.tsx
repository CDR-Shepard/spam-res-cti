import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import { authGuard } from '@/lib/guard';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    const target = authGuard(context.auth.isAuthenticated, location.href);
    if (target) throw redirect(target);
  },
  component: () => <AppShell><Outlet /></AppShell>,
});
