import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test/render';
import { Wordmark } from './app-nav';

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
