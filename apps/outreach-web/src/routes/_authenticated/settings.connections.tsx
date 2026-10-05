import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ConnectionsPage } from '@/components/connections-page';

export const Route = createFileRoute('/_authenticated/settings/connections')({
  // outreach-api's Salesforce callback lands here with `?connected=1` or
  // `?error=<code>`. Junk values are dropped rather than failing the page.
  validateSearch: z.object({
    connected: z.coerce.number().optional().catch(undefined),
    error: z.coerce.string().optional().catch(undefined),
  }),
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  const { connected, error } = Route.useSearch();
  return <ConnectionsPage connected={connected === 1} error={error} />;
}
