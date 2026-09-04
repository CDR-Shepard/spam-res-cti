import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Tenant } from '@cti/contracts';
import { AuthProvider, useAuth } from './auth';

const otherTenant: Tenant = { id: 'O2', name: 'Other Co', slug: 'other-co', timezone: 'UTC', status: 'active' };

function SwitchButton() {
  const auth = useAuth();
  return <button onClick={() => auth.switchTenant(otherTenant)}>switch</button>;
}

describe('AuthProvider switchTenant', () => {
  it('clears the query cache so a previously cached query is gone after switching tenants', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['team'], { members: [] });
    expect(qc.getQueryData(['team'])).toEqual({ members: [] });

    render(
      <QueryClientProvider client={qc}>
        <AuthProvider><SwitchButton /></AuthProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(qc.getQueryData(['team'])).toBeUndefined();
  });
});
