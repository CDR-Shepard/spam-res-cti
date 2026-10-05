import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { NeedsReviewItem, NeedsReviewResponse, ReviewDecision } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiRequestError } from '@/lib/api';
import { decideReview, getReview, outreachKeys } from '@/lib/outreach-api';
import { DNC_CATEGORY_WORDS, errorText, formatDateTime } from '@/lib/outreach-words';
import { ConfirmAction } from './confirm-action';

const REVIEW_ERROR_WORDS = {
  NOT_OWNER: "Only the record's owner or an admin can decide this one.",
  NOT_IN_REVIEW: 'Someone else already decided this one. The list has been refreshed.',
};

interface Decision { enrollmentId: string; decision: ReviewDecision['decision'] }

export function ReviewPage() {
  const qc = useQueryClient();
  const review = useQuery({ queryKey: outreachKeys.review, queryFn: getReview });
  const decide = useMutation({
    mutationFn: ({ enrollmentId, decision }: Decision) => decideReview(enrollmentId, decision),
    onSuccess: (_done, { enrollmentId }) => {
      // The server has moved this enrollment out of needs_review; drop the row
      // here instead of refetching the whole list.
      qc.setQueryData<NeedsReviewResponse>(outreachKeys.review, (old) => old && { items: old.items.filter((i) => i.enrollmentId !== enrollmentId) });
      void qc.invalidateQueries({ queryKey: outreachKeys.plans });
    },
    onError: (error) => {
      // Someone else decided first: the row on screen is stale, so load the list again.
      if (error instanceof ApiRequestError && error.code === 'NOT_IN_REVIEW') void qc.invalidateQueries({ queryKey: outreachKeys.review });
    },
  });
  const items = review.data?.items;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Needs review</h1>
      <Card>
        <CardHeader>
          <CardTitle>Flagged by the AI</CardTitle>
          <CardDescription>The notes suggest these people may not want to be contacted. Nothing goes to them until someone decides. Dismiss to put them back in their sequence, or confirm to opt them out.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {review.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {review.error && <p role="alert" className="text-sm text-destructive">{errorText(review.error)}</p>}
          {decide.error && <p role="alert" className="text-sm text-destructive">{errorText(decide.error, REVIEW_ERROR_WORDS)}</p>}
          {items && items.length === 0 && <p className="text-sm text-muted-foreground">Nothing to review.</p>}
          {items && items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Person</TableHead><TableHead>Why</TableHead><TableHead>What the notes say</TableHead><TableHead>Campaign</TableHead><TableHead>Owner</TableHead><TableHead /></TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <ReviewRow key={item.enrollmentId} item={item} busy={decide.isPending} onDecide={(decision) => decide.mutate({ enrollmentId: item.enrollmentId, decision })} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface ReviewRowProps { item: NeedsReviewItem; busy: boolean; onDecide: (decision: ReviewDecision['decision']) => void }

function ReviewRow({ item, busy, onDecide }: ReviewRowProps) {
  const label = item.name ?? item.sfRecordId;
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">Flagged {formatDateTime(item.flaggedAt)}</div>
      </TableCell>
      <TableCell>{DNC_CATEGORY_WORDS[item.category]}</TableCell>
      <TableCell className="max-w-xs whitespace-normal"><blockquote className="border-l-2 pl-2 italic">“{item.quote}”</blockquote></TableCell>
      <TableCell><Link to="/campaigns/$campaignId" params={{ campaignId: item.campaignId }} className="underline-offset-4 hover:underline">{item.campaignName}</Link></TableCell>
      <TableCell>{item.ownerName ?? '—'}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} aria-label={`Dismiss flag for ${label}`} onClick={() => onDecide('dismiss')}>Dismiss</Button>
          <ConfirmAction
            label="Confirm do not contact"
            triggerAriaLabel={`Confirm do not contact for ${label}`}
            title={`Opt ${label} out of everything?`}
            description={`This opts ${label} out of everything: their phone numbers go on your company's opt-out list, so no campaign or rep dialer will call or text them, and they leave this campaign. You can't undo this here.`}
            confirmLabel="Confirm do not contact"
            destructive
            disabled={busy}
            onConfirm={() => onDecide('confirm')}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
