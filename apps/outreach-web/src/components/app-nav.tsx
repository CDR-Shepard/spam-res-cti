import { Link } from '@tanstack/react-router';
import { FlaskConical, Flag, LayoutDashboard, LogOut, Megaphone, Settings, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { TenantSwitcher } from './tenant-switcher';

interface NavItem { to: '/' | '/campaigns' | '/review' | '/team' | '/test-record' | '/settings/connections'; label: string; icon: LucideIcon; exact?: boolean; adminOnly?: boolean }

/** The main nav, in the order the app has always had it. "Test a record" is for admins. */
const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/review', label: 'Needs review', icon: Flag },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/test-record', label: 'Test a record', icon: FlaskConical, adminOnly: true },
  { to: '/settings/connections', label: 'Settings', icon: Settings },
];

const ITEM_CLASS = cn(
  'group flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13.5px] font-medium text-muted-foreground transition-[background-color,color,box-shadow] duration-150 ease-out',
  'hover:bg-foreground/[0.045] hover:text-foreground',
  'data-[status=active]:bg-sidebar-accent data-[status=active]:font-semibold data-[status=active]:text-foreground data-[status=active]:shadow-[0_0_0_1px_var(--sidebar-border),0_1px_2px_rgb(15_15_14/0.05)]',
);

/** `onNavigate` lets the mobile drawer close itself once a link is picked. */
export function MainNav({ onNavigate }: { onNavigate?: () => void }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map(({ to, label, icon: Icon, exact }) => (
        <Link key={to} to={to} activeOptions={exact ? { exact: true } : undefined} className={ITEM_CLASS} onClick={onNavigate}>
          <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md transition-colors duration-150 group-data-[status=active]:bg-brand group-data-[status=active]:text-brand-foreground">
            <Icon className="size-4" strokeWidth={1.9} />
          </span>
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** The product's name as text, with a small lime mark drawn in CSS. */
export function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/" onClick={onNavigate} className="inline-flex items-center gap-2 rounded-md text-[17px] font-semibold tracking-[-0.025em] text-foreground">
      <span aria-hidden className="grid size-[22px] place-items-center rounded-[6px] bg-brand shadow-[inset_0_0_0_1px_rgb(15_15_14/0.08)]">
        <span className="h-2.5 w-1 -skew-x-12 rounded-[1px] bg-brand-foreground" />
      </span>
      Outreach
    </Link>
  );
}

/** Bottom of the sidebar: which workspace, who is signed in, and Sign out. */
export function AccountPanel() {
  const auth = useAuth();
  const email = auth.user?.email ?? '';
  const signOut = () => void auth.signOut().then(() => window.location.assign('/sign-in'));
  return (
    <div className="space-y-3 border-t border-sidebar-border px-3 pt-3 pb-4">
      <TenantSwitcher />
      <div className="flex min-w-0 items-center gap-2.5 px-1">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background uppercase">
          {email.slice(0, 1) || '·'}
        </span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground" title={email}>{email}</span>
      </div>
      <Button variant="ghost" size="sm" className="w-full justify-start px-2 text-muted-foreground hover:text-foreground" onClick={signOut}>
        <LogOut aria-hidden />
        Sign out
      </Button>
    </div>
  );
}
