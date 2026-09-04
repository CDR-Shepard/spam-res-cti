import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/_authenticated/')({ component: Dashboard });

function Dashboard() {
  const auth = useAuth();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{auth.activeTenant?.name}</CardTitle>
        <CardDescription>Signed in as {auth.user?.email}{auth.user?.isAdmin ? ' (admin)' : ''}.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Lists, contacts, suppression, and CRM connections arrive in the next release. Use Team to invite your people.</CardContent>
    </Card>
  );
}
