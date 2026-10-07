import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown } from 'lucide-react';
import { TenantsResponse } from '@cti/contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Super admins only: choose which tenant the app acts on (sent as X-Org-Id). Everyone else sees their workspace's name. */
export function TenantSwitcher() {
  const auth = useAuth();
  const tenants = useQuery({ queryKey: ['admin', 'tenants'], queryFn: () => api('/api/admin/tenants', TenantsResponse), enabled: auth.user?.isSuperAdmin === true });
  if (!auth.user?.isSuperAdmin) return <span className="block truncate px-1 text-[13px] font-semibold">{auth.activeTenant?.name}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          <span className="truncate">{auth.activeTenant?.name ?? 'Choose tenant'}</span>
          <ChevronsUpDown aria-hidden className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-52">
        {(tenants.data?.tenants ?? []).map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => auth.switchTenant(t)}>{t.name} <span className="ml-auto text-xs text-muted-foreground">{t.slug}</span></DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
