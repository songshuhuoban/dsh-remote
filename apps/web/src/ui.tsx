/** Shared building blocks on shadcn/ui with the DSH theme (src/index.css). */
import { type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import { ChevronDown } from './icons';
import { errorText } from './api';
import { cn } from '@/lib/utils';
import { fieldClass } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 className={cn('size-4 animate-spin', className)} aria-hidden="true" />
);

export const Err = ({ error, className }: { error: unknown; className?: string }) =>
  error ? (
    <div
      role="alert"
      className={cn(
        'swap flex items-start gap-2 rounded-lg bg-destructive/[0.07] px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{errorText(error)}</span>
    </div>
  ) : null;

/** A quiet placeholder for an empty region: icon tile, title, one line of guidance. */
export const Empty = ({
  icon,
  title,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn('swap grid justify-items-start gap-2 py-6', className)}>
    <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-accent text-muted-foreground [&_svg]:size-5">
      {icon}
    </div>
    <h3 className="text-md font-medium text-foreground">{title}</h3>
    <p className="max-w-prose text-base text-muted-foreground">{children}</p>
  </div>
);

/** A label above its control; `hint` stays outside the label so the control's name is exact. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">
        {label}
        {children}
      </label>
      {hint ? <p className="text-xs text-caption">{hint}</p> : null}
    </div>
  );
}

/** A native select styled as a DSH field: keeps platform pickers and form semantics. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative block', className)}>
      <select
        className={cn(fieldClass, 'h-10 cursor-pointer appearance-none pr-9 font-normal')}
        {...props}
      />
      <ChevronDown
        size={14}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-caption"
      />
    </span>
  );
}

/** A row of dialog or form actions, primary first, left-aligned. */
export const Actions = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('flex flex-wrap items-center gap-2 pt-1', className)}>{children}</div>
);

export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className={className}
        closeDisabled={busy}
        aria-describedby={undefined}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
