export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

// Workers' WebCrypto caps PBKDF2 at 100,000 iterations.
const ITERATIONS = 100_000;
const PREFIX = 'pbkdf2_sha256';
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
}

export const isPbkdf2Hash = (stored: string) => stored.startsWith(`${PREFIX}$`);

/** Portable WebCrypto hashing, used where argon2 is unavailable (Cloudflare Workers). */
export const pbkdf2Passwords: PasswordHasher = {
  async hash(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return `${PREFIX}$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
  },
  async verify(password, stored) {
    const [prefix, rounds, salt, expected] = stored.split('$');
    const iterations = Number(rounds);
    if (prefix !== PREFIX || !Number.isSafeInteger(iterations) || iterations < 1 || !salt || !expected)
      return false;
    const actual = await derive(password, unb64(salt), iterations),
      wanted = unb64(expected);
    let difference = actual.length ^ wanted.length;
    for (let i = 0; i < actual.length; i++) difference |= actual[i]! ^ (wanted[i] ?? 0);
    return difference === 0;
  },
};
