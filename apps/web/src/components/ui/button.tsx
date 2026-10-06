import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

/** shadcn Button tuned to DSH: 36px controls, 12px corners, near-black primary, hairline outline. */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg text-base font-medium whitespace-nowrap transition-[background-color,color,box-shadow,opacity] duration-150 ease-ds outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline:
          'border-[0.8px] border-border bg-outline-fill text-foreground hover:bg-accent dark:hover:bg-accent-active',
        secondary: 'bg-accent text-foreground hover:bg-accent-active',
        ghost: 'text-foreground hover:bg-accent active:bg-accent-active',
        quiet: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-link underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3.5 has-[>svg]:px-3',
        sm: 'h-8 rounded-md px-3 text-sm has-[>svg]:px-2.5',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-sm': 'size-8 rounded-md',
        'icon-xs': "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    // A link sits in running text: no box, whatever the size.
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0 has-[>svg]:px-0' }],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
