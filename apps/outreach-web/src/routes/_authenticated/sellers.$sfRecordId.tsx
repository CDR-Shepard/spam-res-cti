import { createFileRoute, useLocation } from '@tanstack/react-router';
import { SellerConversationPage } from '@/components/seller-conversation-page';
import { eventIdFromHash } from '@/lib/seller-words';

// A seller's conversation. Sam's alerts and the Salesforce Tasks she writes link here: `/sellers/<sfRecordId>`, and a Task
// adds `#event-<id>` to open on the row it was written for.
export const Route = createFileRoute('/_authenticated/sellers/$sfRecordId')({ component: SellerRoute });

function SellerRoute() {
  const { sfRecordId } = Route.useParams();
  const hash = useLocation({ select: (location) => location.hash });
  // Keyed so moving between sellers starts each page with fresh local state.
  return <SellerConversationPage key={sfRecordId} sfRecordId={sfRecordId} focusEventId={eventIdFromHash(hash)} />;
}
