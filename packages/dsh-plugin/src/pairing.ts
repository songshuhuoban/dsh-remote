/** Pairing: a one-time relay link becomes this Host's relay address and connector credential. */
export interface PairingTarget {
  /** Relay HTTP origin that issued the link, e.g. https://dsh.example.com */
  origin: string;
  code: string;
  /** Connector endpoint derived from the origin */
  relayUrl: string;
}
export interface PairingResult {
  relayUrl: string;
  connectorToken: string;
  instance: { id: string; name: string };
}
export class PairingError extends Error {
  constructor(
    readonly code: 'invalid_link' | 'invalid_code' | 'rate_limited' | 'unreachable' | 'relay_error',
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Accepts `https://relay/pair/ABCD-EFGH`, with or without the scheme. */
export function parsePairingLink(input: string): PairingTarget {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new PairingError('invalid_link', 'Paste the full pairing link shown by the relay');
  }
  const match = url.pathname.match(/^\/pair\/([0-9A-Za-z-]{4,40})\/?$/);
  if (!match || url.username || url.password || url.search || url.hash)
    throw new PairingError('invalid_link', 'Paste the full pairing link shown by the relay');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    throw new PairingError('invalid_link', 'Pairing links must use https (http only on loopback)');
  return {
    origin: url.origin,
    code: match[1]!,
    relayUrl: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws/connector`,
  };
}

/** Exchanges a pairing link for a connector credential. The code is single use. */
export async function exchangePairing(
  link: string,
  transport: typeof fetch = fetch,
): Promise<PairingResult> {
  const target = parsePairingLink(link);
  let response: Response;
  try {
    response = await transport(`${target.origin}/api/connector/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: target.code }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PairingError('unreachable', `Could not reach ${target.origin}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 404)
    throw new PairingError('invalid_code', 'This pairing link is invalid, used or expired');
  if (response.status === 429)
    throw new PairingError('rate_limited', 'Too many attempts; wait a minute and try again');
  const instance = body?.instance as { id?: unknown; name?: unknown } | undefined;
  if (
    !response.ok ||
    typeof body?.connectorToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32,4096}$/.test(body.connectorToken) ||
    typeof instance?.id !== 'string' ||
    typeof instance.name !== 'string'
  )
    throw new PairingError('relay_error', `Relay rejected pairing (HTTP ${response.status})`);
  return {
    relayUrl: target.relayUrl,
    connectorToken: body.connectorToken,
    instance: { id: instance.id, name: instance.name },
  };
}
