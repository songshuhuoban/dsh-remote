import { useEffect, useRef, type ReactNode } from 'react';
import { Loader2, Shield, X } from 'lucide-react';
import { errorText } from './api';
export const Spinner = () => <Loader2 className="spin" size={16} />;
export const Err = ({ error }: { error: unknown }) =>
  error ? (
    <div role="alert" className="error">
      <Shield size={15} />
      <span>{errorText(error)}</span>
    </div>
  ) : null;
export const Empty = ({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    <p>{children}</p>
  </div>
);
export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-top">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭">
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
