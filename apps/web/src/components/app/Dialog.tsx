/**
 * The modal dialog. A dialog that is a route (docs/ROUTES.md) renders always-open
 * and closes by navigating to its parent (see src/lib/dialogs/route.ts), so Back
 * closes it and a link opens it; a dialog that is local to a page — a delete
 * confirmation, a rename — owns its own `open` and has no URL.
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
