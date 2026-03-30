import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [scheme, saltEncoded, hashEncoded] = storedHash.split('$');
  if (scheme !== 'scrypt' || !saltEncoded || !hashEncoded) return false;

  const salt = Buffer.from(saltEncoded, 'base64url');
  const expected = Buffer.from(hashEncoded, 'base64url');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}