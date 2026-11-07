import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, timingSafeEqual, randomToken, sha256Hex, randomId, DUMMY_PASSWORD_HASH } from '../../src/worker/lib/crypto';

describe('password hashing', () => {
  it('hashes in the pbkdf2$iter$salt$hash format and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    const parts = h.split('$');
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('100000');
    expect(atob(parts[2]).length).toBe(16);
    expect(atob(parts[3]).length).toBe(32);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
  });
  it('uses a random salt per hash', async () => {
    const a = await hashPassword('same-password', 1000);
    const b = await hashPassword('same-password', 1000);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
  });
  it('rejects malformed or out-of-policy hashes', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$a$b')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$999999999$AAAA$AAAA')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$1000$!!!$AAAA')).toBe(false);
    expect(await verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe('helpers', () => {
  it('timingSafeEqual', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
  });
  it('tokens and ids', async () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
    expect(randomId('p')).toMatch(/^p_[0-9a-f]{24}$/);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
