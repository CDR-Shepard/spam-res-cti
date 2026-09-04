import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/lib/auth';
import { TenantSwitcher } from './tenant-switcher';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 px-6 py-3">
        <Link to="/" className="font-semibold">Outreach</Link>
        <nav className="flex gap-3 text-sm">
          <Link to="/" activeProps={{ className: 'font-medium' }}>Dashboard</Link>
          <Link to="/team" activeProps={{ className: 'font-medium' }}>Team</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <TenantSwitcher />
          <span className="text-sm text-muted-foreground">{auth.user?.email}</span>
          <Button variant="ghost" size="sm" onClick={() => void auth.signOut().then(() => window.location.assign('/sign-in'))}>Sign out</Button>
        </div>
      </header>
      <Separator />
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
