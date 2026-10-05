import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';

export interface ConfirmActionProps {
  /** Text on the button that opens the dialog. */
  label: string;
  /** Accessible name for the opening button when several identical buttons share a page (e.g. one per table row). */
  triggerAriaLabel?: string;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** A button that asks before doing something that is hard to take back (go live, archive, confirm do-not-contact, disconnect). */
export function ConfirmAction({ label, triggerAriaLabel, title, description, confirmLabel, onConfirm, disabled, destructive }: ConfirmActionProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={destructive ? 'destructive' : 'default'} disabled={disabled} aria-label={triggerAriaLabel}>{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={destructive ? buttonVariants({ variant: 'destructive' }) : undefined} onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
