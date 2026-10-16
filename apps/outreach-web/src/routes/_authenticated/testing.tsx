import { createFileRoute } from '@tanstack/react-router';
import { TestingPage } from '@/components/testing-page';

// Testing (admins): the test phones list and the inbound test calls. The page shows non-admins a not-allowed line.
export const Route = createFileRoute('/_authenticated/testing')({ component: TestingPage });
