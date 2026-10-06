import * as React from 'react';
import { cn } from '@/lib/utils';

/** DSH field: 40px, soft fill, hairline that darkens on focus. */
export const fieldClass =
  'w-full min-w-0 rounded-lg border-[0.8px] border-input bg-field px-3 text-base text-foreground transition-[border-color,box-shadow] duration-150 ease-ds outline-none placeholder:text-caption focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(fieldClass, 'h-10 py-2 file:border-0 file:bg-transparent', className)}
      {...props}
    />
  );
}

export { Input };
