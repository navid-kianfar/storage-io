import type * as React from 'react';
import { Button as ButtonPrimitive, buttonVariants } from '@/components/ui/button';

/**
 * The app's button. A pass-through wrapper on purpose: the variants and the
 * `--control-h`-derived sizes already live in the primitive, and application code
 * imports from the kit so a future change to what "our button" means lands in one
 * file rather than in every page.
 *
 * `ButtonGroup` is the concept's `.btn-group` — a split button whose main action
 * sits beside a chevron that opens the rest.
 */
export const Button = ButtonPrimitive;
export { buttonVariants };
export type ButtonProps = React.ComponentProps<typeof ButtonPrimitive>;

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from '@/components/ui/button-group';
