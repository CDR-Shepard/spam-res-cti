import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** The heading level the title takes (h2 under a page's h1 by default). */
  level?: 2 | 3;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** A titled white card: the title row sits over a hairline, then the body. */
export function Section({ title, description, actions, level = 2, className, bodyClassName, children }: SectionProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card text-card-foreground', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 sm:px-6">
        <div className="min-w-0 space-y-1">
          <Heading className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">{title}</Heading>
          {description && <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('px-5 py-5 sm:px-6', bodyClassName)}>{children}</div>
    </section>
  );
}
