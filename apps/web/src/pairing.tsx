import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Clipboard } from 'lucide-react';
import { isOnline, post, type Instance } from './api';
import { Err, Modal, Spinner } from './ui';

export type Pairing = { code: string; expiresAt: number; pairingUrl: string };

export const requestPairing = (instanceId: string) =>
  post<Pairing>(`/api/instances/${encodeURIComponent(instanceId)}/pairing`, {});

function useCountdown(until: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return { left, label: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

/** One-time link the DSH plugin exchanges for its connector credential. */
export function PairingPanel({
  pairing,
  instance,
  onRenew,
  renewing,
}: {
  pairing: Pairing;
  instance?: Instance;
  onRenew: () => void;
  renewing: boolean;
}) {
  const [copied, setCopied] = useState(false),
    countdown = useCountdown(pairing.expiresAt),
    connected = !!instance && isOnline(instance);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (connected)
    return (
      <p className="pairing-done swap" role="status">
        <Check size={16} />
        已连接
      </p>
    );
  return (
    <div className="pairing">
      <p>在 DSH 的插件页打开 DSH Remote，粘贴此链接。</p>
      <div className="pairing-link">
        <input
          readOnly
          aria-label="配对链接"
          value={pairing.pairingUrl}
          disabled={countdown.left === 0}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={copied ? '已复制' : '复制配对链接'}
          disabled={countdown.left === 0}
          onClick={() => {
            navigator.clipboard
              ?.writeText(pairing.pairingUrl)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          <span key={copied ? 'done' : 'copy'} className="swap">
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
          </span>
        </button>
      </div>
      <p className="pairing-meta" role="status">
        <span key={countdown.left === 0 ? 'expired' : 'valid'} className="swap">
          {countdown.left > 0 ? `${countdown.label} 后失效，仅可使用一次` : '已失效'}
        </span>
        <button type="button" className="text-button" disabled={renewing} onClick={onRenew}>
          {renewing ? <Spinner /> : null}重新生成
        </button>
      </p>
    </div>
  );
}

/** Pairs or re-pairs an existing instance. Pairing replaces its connector credential. */
export function PairInstance({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const mutation = useMutation({ mutationFn: () => requestPairing(instance.id) });
  return (
    <Modal
      title={`配对 ${instance.name}`}
      description={mutation.data ? undefined : '配对后，这台实例原有的连接令牌会失效。'}
      onClose={onClose}
      busy={mutation.isPending}
    >
      {mutation.data ? (
        <>
          <PairingPanel
            pairing={mutation.data}
            instance={instance}
            onRenew={() => mutation.mutate()}
            renewing={mutation.isPending}
          />
          <div className="modal-actions">
            <button className="primary" onClick={onClose}>
              完成
            </button>
          </div>
        </>
      ) : (
        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : null}生成配对链接
          </button>
          <button className="quiet" onClick={onClose} disabled={mutation.isPending}>
            取消
          </button>
        </div>
      )}
      <Err error={mutation.error} />
    </Modal>
  );
}

/** Shown when someone opens a pairing link in a browser instead of pasting it into DSH. */
export function PairingLanding() {
  return (
    <main className="pairing-landing">
      <h1>DSH Remote 配对链接</h1>
      <p>复制当前地址，粘贴到 DSH 插件页的 DSH Remote 中。链接只能使用一次。</p>
      <a className="text-button" href="/">
        打开控制台
      </a>
    </main>
  );
}
