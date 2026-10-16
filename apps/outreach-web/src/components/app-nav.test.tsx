import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test/render';
import { MainNav, Wordmark } from './app-nav';

afterEach(() => vi.unstubAllGlobals());

describe('Wordmark', () => {
  it('is a link to the dashboard named Lead Specialist, marked with a headset, and never says Outreach', async () => {
    renderWithRouter(<Wordmark />);
    const link = await screen.findByRole('link', { name: 'Lead Specialist' });
    expect(link).toHaveAttribute('href', '/');
    expect(link.querySelector('svg.lucide-headset')).toBeInTheDocument();
    expect(link).not.toHaveTextContent(/outreach/i);
  });
});

describe('MainNav', () => {
  it('shows an admin "Agent prompt" just before Settings', async () => {
    renderWithRouter(<MainNav />, { isAdmin: true });
    const link = await screen.findByRole('link', { name: 'Agent prompt' });
    expect(link).toHaveAttribute('href', '/settings/agent-prompt');
    expect(link.querySelector('svg.lucide-scroll-text')).toBeInTheDocument();
    const names = screen.getAllByRole('link').map((a) => a.textContent);
    expect(names.indexOf('Agent prompt')).toBe(names.indexOf('Settings') - 1);
  });

  it('shows an admin "Testing" between "Test a record" and "Agent prompt"', async () => {
    renderWithRouter(<MainNav />, { isAdmin: true });
    const link = await screen.findByRole('link', { name: 'Testing' });
    expect(link).toHaveAttribute('href', '/testing');
    expect(link.querySelector('svg.lucide-phone-incoming')).toBeInTheDocument();
    const names = screen.getAllByRole('link').map((a) => a.textContent);
    expect(names.indexOf('Test a record')).toBe(names.indexOf('Testing') - 1);
    expect(names.indexOf('Agent prompt')).toBe(names.indexOf('Testing') + 1);
  });

  it('never shows "Testing" to someone who is not an admin', async () => {
    renderWithRouter(<MainNav />);
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Testing' })).not.toBeInTheDocument();
  });

  it('never shows "Agent prompt" to someone who is not an admin', async () => {
    renderWithRouter(<MainNav />);
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Agent prompt' })).not.toBeInTheDocument();
  });
});
