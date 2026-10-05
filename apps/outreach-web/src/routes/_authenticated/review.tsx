import { createFileRoute } from '@tanstack/react-router';
import { ReviewPage } from '@/components/review-page';

export const Route = createFileRoute('/_authenticated/review')({ component: ReviewPage });
