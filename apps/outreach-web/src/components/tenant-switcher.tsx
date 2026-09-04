import { useQuery } from '@tanstack/react-query';
import { TenantsResponse } from '@cti/contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Super admins only: choose which tenant the app acts on (sent as X-Org-Id). */
export function TenantSwitcher() {
  const auth = useAuth();
  const tenants = useQuery({ queryKey: ['admin', 'tenants'], queryFn: () => api('/api/admin/tenants', TenantsResponse), enabled: auth.user?.isSuperAdmin === true });
  if (!auth.user?.isSuperAdmin) return <span className="text-sm text-muted-foreground">{auth.activeTenant?.name}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm">{auth.activeTenant?.name ?? 'Choose tenant'}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(tenants.data?.tenants ?? []).map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => auth.switchTenant(t)}>{t.name} <span className="ml-2 text-xs text-muted-foreground">{t.slug}</span></DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
