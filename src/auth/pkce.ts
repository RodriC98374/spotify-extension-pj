import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Challenge S256 de RFC 7636: BASE64URL(SHA256(verifier)). */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkcePair(): PkcePair {
  // 64 bytes dan 86 caracteres base64url, dentro del rango de 43 a 128 que exige el RFC.
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: challengeFor(verifier) };
}

export function createState(): string {
  return randomBytes(16).toString('hex');
}
