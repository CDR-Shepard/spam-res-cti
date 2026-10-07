import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'live' | 'outline';

const DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  neutral: 'bg-muted-foreground/70',
  live: 'bg-brand-foreground',
  outline: 'bg-muted-foreground/70',
};

/** A soft tinted pill with a small dot. "live" is the lime pill (ink text), and its dot pulses unless motion is reduced. */
export function StatusBadge({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <Badge variant={tone} className={className}>
      <span aria-hidden className={cn('relative inline-flex size-1.5 shrink-0 rounded-full', DOT[tone])}>
        {tone === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-brand-foreground/60 motion-reduce:hidden" />}
      </span>
      {children}
    </Badge>
  );
}
