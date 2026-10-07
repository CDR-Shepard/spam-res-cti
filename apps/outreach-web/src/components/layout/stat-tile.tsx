import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Render as a list item (inside a StatGrid given `as="ul"`). */
  as?: 'div' | 'li';
  /** `md` for a value that is words or a date rather than a figure. */
  size?: 'lg' | 'md';
}

/**
 * One key figure: a small uppercase label over a big tabular number. The label comes first in the DOM and a space
 * separates it from the value, so the tile reads (and its text content is) "Label value".
 */
export function StatTile({ label, value, hint, className, as = 'div', size = 'lg' }: StatTileProps) {
  const Tag = as;
  return (
    <Tag className={cn('flex min-w-0 flex-col gap-1.5 bg-card px-4 py-3.5 sm:px-5 sm:py-4', className)}>
      <span className="eyebrow truncate">{label}</span>{' '}
      <span className={cn('truncate font-semibold tracking-[-0.02em] tabular-nums', size === 'lg' ? 'text-xl leading-7 sm:text-2xl' : 'text-[15px] leading-7 sm:text-base sm:leading-8')}>{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </Tag>
  );
}

interface StatGridProps {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'ul';
  'aria-label'?: string;
}

/** Tiles share hairlines like one ruled table: a 1px gap over the border colour. */
export function StatGrid({ children, className, as = 'div', ...rest }: StatGridProps) {
  const Tag = as;
  return (
    <Tag
      className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]', className)}
      aria-label={rest['aria-label']}
    >
      {children}
    </Tag>
  );
}
