import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('AuthProvider startSignIn', () => {
  function StartButtons({ returnTo }: { returnTo?: string }) {
    const auth = useAuth();
    return (
      <>
        <button onClick={() => auth.startSignIn(returnTo)}>default</button>
        <button onClick={() => auth.startSignIn(returnTo, 'workos')}>workos</button>
      </>
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it('navigates to the Salesforce start route by default and to WorkOS when asked, carrying an encoded returnTo', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider><StartButtons returnTo="/campaigns?x=1" /></AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'default' }));
    await userEvent.click(screen.getByRole('button', { name: 'workos' }));
    expect(assign).toHaveBeenNthCalledWith(1, '/api/auth/salesforce/start?returnTo=%2Fcampaigns%3Fx%3D1');
    expect(assign).toHaveBeenNthCalledWith(2, '/api/auth/workos/start?returnTo=%2Fcampaigns%3Fx%3D1');
  });
});
