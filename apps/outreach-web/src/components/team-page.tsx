import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Invite, InvitesResponse, TeamMember, TeamResponse, type RoleSlug } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiRequestError, json } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function TeamPage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const isAdmin = auth.user?.isAdmin || auth.user?.isSuperAdmin;
  const team = useQuery({ queryKey: ['team'], queryFn: () => api('/api/team', TeamResponse) });
  const invites = useQuery({ queryKey: ['team', 'invites'], queryFn: () => api('/api/team/invites', InvitesResponse), enabled: Boolean(isAdmin) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleSlug>('member');
  const invite = useMutation({
    mutationFn: () => api('/api/team/invites', Invite, { method: 'POST', body: json({ email, role }) }),
    onSuccess: () => { setEmail(''); void qc.invalidateQueries({ queryKey: ['team', 'invites'] }); },
  });
  const toggleAdmin = useMutation({
    mutationFn: (m: TeamMember) => api(`/api/team/${m.id}`, TeamMember, { method: 'PATCH', body: json({ isAdmin: !m.isAdmin }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  });
  const errorText = (e: unknown) => (e instanceof ApiRequestError ? (e.code === 'WORKOS_NOT_LINKED' ? 'This workspace is not linked to WorkOS yet.' : e.message) : e ? 'Something went wrong.' : null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent>
          {team.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {team.error && <p role="alert" className="text-sm text-destructive">{errorText(team.error)}</p>}
          {team.data && (
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Product</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
              <TableBody>
                {team.data.members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>{m.displayName ?? '—'}</TableCell>
                    <TableCell>{m.isAdmin ? <Badge>Admin</Badge> : <Badge variant="secondary">Member</Badge>}</TableCell>
                    <TableCell>{m.signedIn ? 'Signed in' : 'Not yet'}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" disabled={m.id === auth.user?.userId || toggleAdmin.isPending} onClick={() => toggleAdmin.mutate(m)}>
                          {m.isAdmin ? 'Remove admin' : 'Make admin'}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {isAdmin && (
        <Card>
          <CardHeader><CardTitle>Invites</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
              <div className="grid gap-1">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rep@company.com" />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="invite-role">Role</Label>
                <select id="invite-role" className="h-9 rounded-md border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as RoleSlug)}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <Button type="submit" disabled={invite.isPending}>Send invite</Button>
            </form>
            {invite.error && <p role="alert" className="text-sm text-destructive">{errorText(invite.error)}</p>}
            {invites.error && <p role="alert" className="text-sm text-destructive">{errorText(invites.error)}</p>}
            {invites.data && invites.data.invites.filter((i) => i.state === 'pending').length === 0 && <p className="text-sm text-muted-foreground">No pending invites.</p>}
            {invites.data && invites.data.invites.filter((i) => i.state === 'pending').map((i) => (
              <div key={i.id} className="flex items-center justify-between text-sm">
                <span>{i.email}</span>
                <span className="text-muted-foreground">{i.role ?? 'member'} · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
