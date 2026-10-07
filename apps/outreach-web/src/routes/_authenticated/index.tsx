import { createFileRoute } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/_authenticated/')({ component: Dashboard });

function Dashboard() {
  const auth = useAuth();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Dashboard"
        title={auth.activeTenant?.name}
        description={<>Signed in as {auth.user?.email}{auth.user?.isAdmin ? ' (admin)' : ''}.</>}
      />
      <div className="flex items-start gap-4 rounded-xl border bg-card px-5 py-5 sm:px-6">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-brand-foreground">
          <Sparkles className="size-4" />
        </span>
        <p className="pt-2 text-sm leading-6 text-muted-foreground">Lists, contacts, suppression, and CRM connections arrive in the next release. Use Team to invite your people.</p>
      </div>
    </div>
  );
}
