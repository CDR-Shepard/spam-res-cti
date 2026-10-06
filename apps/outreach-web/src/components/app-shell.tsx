import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/lib/auth';
import { TenantSwitcher } from './tenant-switcher';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link to="/" className="font-semibold">Outreach</Link>
        <nav aria-label="Main" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'font-medium' }}>Dashboard</Link>
          <Link to="/campaigns" activeProps={{ className: 'font-medium' }}>Campaigns</Link>
          <Link to="/review" activeProps={{ className: 'font-medium' }}>Needs review</Link>
          <Link to="/team" activeProps={{ className: 'font-medium' }}>Team</Link>
          {isAdmin && <Link to="/test-record" activeProps={{ className: 'font-medium' }}>Test a record</Link>}
          <Link to="/settings/connections" activeProps={{ className: 'font-medium' }}>Settings</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <TenantSwitcher />
          <span className="text-sm text-muted-foreground">{auth.user?.email}</span>
          <Button variant="ghost" size="sm" onClick={() => void auth.signOut().then(() => window.location.assign('/sign-in'))}>Sign out</Button>
        </div>
      </header>
      <Separator />
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  );
}
