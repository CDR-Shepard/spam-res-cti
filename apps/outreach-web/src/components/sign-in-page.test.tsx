import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { SignInPage } from './sign-in-page';

const FALLBACK = 'Sign-in failed. Try again.';

describe('SignInPage', () => {
  it('renders no alert when there is no error', () => {
    renderWithProviders(<SignInPage />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([
    ['bad_state'],
    ['missing_code'],
    ['sign_in_disabled'],
    ['bad_return_to'],
    ['no_tenant'],
  ])('maps the API reason %s to a specific message (not the generic fallback)', (error) => {
    renderWithProviders(<SignInPage error={error} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toBe('');
    expect(alert).not.toHaveTextContent(FALLBACK);
  });
  it('renders the generic fallback for an unknown reason', () => {
    renderWithProviders(<SignInPage error="something_new" />);
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK);
  });
  it('renders the generic fallback for a prototype property name (a public URL like /sign-in?error=constructor must not resolve to Object.prototype)', () => {
    renderWithProviders(<SignInPage error="constructor" />);
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK);
  });
});
