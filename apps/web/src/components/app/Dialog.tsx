/**
 * The modal dialog. Pages render one always-open and close through the dialog
 * host's `onClose` (see src/lib/dialogs/registry.ts) rather than owning `open`
 * themselves, so Back closes it and a link can open it.
 */
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
