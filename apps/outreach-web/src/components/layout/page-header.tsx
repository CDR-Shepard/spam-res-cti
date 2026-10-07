import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links, right-aligned beside the title (they wrap under it on a phone). */
  actions?: ReactNode;
  /** Above the title: a back link or a small label. */
  eyebrow?: ReactNode;
  /** Beside the title, on its baseline: a status badge. */
  meta?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** Every page opens the same way: a 28px title with tight tracking, a muted line under it, actions on the right. */
export function PageHeader({ title, description, actions, eyebrow, meta, className, children }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 space-y-2">
        {eyebrow && <div className="text-[13px] text-muted-foreground">{eyebrow}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em] break-words sm:text-[28px]">{title}</h1>
          {meta}
        </div>
        {description && <div className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
