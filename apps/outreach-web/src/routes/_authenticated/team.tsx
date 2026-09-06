import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '@/components/team-page';

export const Route = createFileRoute('/_authenticated/team')({ component: TeamPage });
