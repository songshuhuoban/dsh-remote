import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldClass } from './input';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, 'min-h-20 resize-y py-2.5 leading-[22px]', className)}
      {...props}
    />
  );
}

export { Textarea };
