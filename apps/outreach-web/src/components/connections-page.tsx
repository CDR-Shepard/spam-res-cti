import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrmConnectionStatus } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { disconnect, getConnection, outreachKeys, startConnection } from '@/lib/outreach-api';
import { errorText, formatDateTime, wordFor } from '@/lib/outreach-words';
import { ConfirmAction } from './confirm-action';
import { FieldMapEditor } from './field-map-editor';

/** Keyed by the `?error=` code outreach-api's Salesforce callback redirects with (A5's `routes/connections.ts`). */
const CALLBACK_ERROR_WORDS: Readonly<Record<string, string>> = {
  access_denied: 'Salesforce sign-in was cancelled.',
  missing_code: 'Salesforce did not send back a sign-in code. Try again.',
  bad_state: 'That connection attempt expired or was started in another tab. Try again.',
  exchange_failed: 'Salesforce did not accept the sign-in. Try again.',
  describe_failed: "We signed in but couldn't read Lead and Opportunity fields. Check the integration user's permissions, then try again.",
  salesforce_disabled: 'Salesforce is not set up on this server yet.',
  server_error: 'Something went wrong on our side. Try again in a minute.',
};
const CALLBACK_ERROR_FALLBACK = 'Connecting Salesforce failed. Try again.';

export interface ConnectionsPageProps {
  /** `?connected=1` after a successful Salesforce sign-in. */
  connected?: boolean;
  /** `?error=<code>` after a failed one. */
  error?: string;
}

export function ConnectionsPage({ connected, error }: ConnectionsPageProps) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: outreachKeys.connection, queryFn: getConnection });
  const start = useMutation({ mutationFn: startConnection, onSuccess: ({ url }) => window.location.assign(url) });
  const remove = useMutation({ mutationFn: disconnect, onSuccess: () => void qc.invalidateQueries({ queryKey: outreachKeys.connection }) });
  const data = status.data;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Connections</h1>
      {connected && <p role="status" className="text-sm">Salesforce is connected.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{wordFor(CALLBACK_ERROR_WORDS, error, CALLBACK_ERROR_FALLBACK)}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Salesforce</CardTitle>
          <CardDescription>Campaigns read Leads and Opportunities through one company-wide Salesforce Integration user.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {status.error && <p role="alert" className="text-sm text-destructive">{errorText(status.error)}</p>}
          {data && (
            <ConnectionStatusBody
              status={data}
              isAdmin={isAdmin}
              busy={start.isPending || remove.isPending}
              onConnect={() => start.mutate()}
              onDisconnect={() => remove.mutate()}
            />
          )}
          {start.error && <p role="alert" className="text-sm text-destructive">{errorText(start.error)}</p>}
          {remove.error && <p role="alert" className="text-sm text-destructive">{errorText(remove.error)}</p>}
        </CardContent>
      </Card>
      {data?.fieldMap && (data.connected || data.status === 'broken') && (
        <FieldMapEditor key={data.connectedAt ?? 'field-map'} value={data.fieldMap} canEdit={isAdmin} />
      )}
    </div>
  );
}

interface StatusBodyProps { status: CrmConnectionStatus; isAdmin: boolean; busy: boolean; onConnect: () => void; onDisconnect: () => void }

function ConnectionStatusBody({ status, isAdmin, busy, onConnect, onDisconnect }: StatusBodyProps) {
  if (status.status === 'broken') {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          The Salesforce connection stopped working{status.lastError ? `: ${status.lastError}` : '.'} Campaigns stay paused until it is reconnected.
        </p>
        <ConnectionDetails status={status} />
        {isAdmin ? <Button onClick={onConnect} disabled={busy}>Reconnect</Button> : <p className="text-sm text-muted-foreground">Ask an admin to reconnect Salesforce.</p>}
      </div>
    );
  }
  if (status.connected) {
    return (
      <div className="space-y-3">
        <ConnectionDetails status={status} />
        {isAdmin && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onConnect} disabled={busy}>Reconnect</Button>
            <ConfirmAction
              label="Disconnect"
              title="Disconnect Salesforce?"
              description="Campaigns stop refreshing and pause until Salesforce is connected again."
              confirmLabel="Disconnect"
              destructive
              disabled={busy}
              onConfirm={onDisconnect}
            />
          </div>
        )}
      </div>
    );
  }
  if (!status.configured) {
    return <p className="text-sm text-muted-foreground">Salesforce is not set up on this server yet. Ask support to add the Salesforce connected-app settings.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">Salesforce is not connected.</p>
      {isAdmin ? (
        <>
          <Button onClick={onConnect} disabled={busy}>Connect Salesforce</Button>
          <p className="text-xs text-muted-foreground">Sign in as your Salesforce Integration user, not your own account.</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Ask an admin to connect Salesforce.</p>
      )}
    </div>
  );
}

function ConnectionDetails({ status }: { status: CrmConnectionStatus }) {
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
      <dt className="text-muted-foreground">Status</dt>
      <dd>{status.status === 'broken' ? <Badge variant="destructive">Needs reconnecting</Badge> : <Badge>Connected</Badge>}</dd>
      <dt className="text-muted-foreground">Salesforce org</dt>
      <dd>{status.instanceUrl ?? '—'}</dd>
      <dt className="text-muted-foreground">Signed in as</dt>
      <dd>{status.username ?? '—'}</dd>
      <dt className="text-muted-foreground">Connected</dt>
      <dd>{status.connectedAt ? formatDateTime(status.connectedAt) : '—'}</dd>
    </dl>
  );
}
