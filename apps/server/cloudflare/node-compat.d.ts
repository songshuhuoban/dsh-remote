// Type surface of the Node APIs the relay uses; workerd provides them via `nodejs_compat`.
// The relay sources are fully typechecked against Bun's Node typings by the root tsconfig.
type NodeBytes = Uint8Array & { toString(encoding?: string): string };
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(value: string | Uint8Array): { digest(encoding: string): string };
  };
  export function randomBytes(size: number): NodeBytes;
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): any;
  export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): any;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
type Buffer = NodeBytes;
