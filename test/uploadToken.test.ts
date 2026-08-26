import { describe, expect, test } from 'vitest';
import { signImageUrl, verifyImageUrl } from '../lib/uploadToken';

const SECRET = 'test-secret-not-a-real-key';
const URL_A = 'https://store.example/listing-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg';
const URL_B = 'https://store.example/listing-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jpg';

describe('upload token', () => {
  test('a token we issued verifies against the url it was issued for', () => {
    expect(verifyImageUrl(URL_A, signImageUrl(URL_A, SECRET), SECRET)).toBe(true);
  });

  // The whole point: holding one object's URL must not let you act on another.
  test('a token for one url does not verify another url', () => {
    expect(verifyImageUrl(URL_B, signImageUrl(URL_A, SECRET), SECRET)).toBe(false);
  });

  test('a token signed with a different secret is rejected', () => {
    expect(verifyImageUrl(URL_A, signImageUrl(URL_A, 'other-secret'), SECRET)).toBe(false);
  });

  test('rejects a missing, empty, or non-string token without throwing', () => {
    for (const token of [undefined, null, '', 0, {}, []]) {
      expect(verifyImageUrl(URL_A, token, SECRET)).toBe(false);
    }
  });

  // timingSafeEqual throws on a length mismatch; the guard must absorb that
  // rather than turning a forged token into a 500.
  test('rejects a token of the wrong length without throwing', () => {
    expect(verifyImageUrl(URL_A, 'abc', SECRET)).toBe(false);
    expect(verifyImageUrl(URL_A, 'f'.repeat(200), SECRET)).toBe(false);
  });

  test('rejects a malformed url instead of throwing', () => {
    expect(verifyImageUrl('not-a-url', 'anything', SECRET)).toBe(false);
  });

  // The path is signed, not the whole URL, so the store can move hosts without
  // invalidating tokens already handed out.
  test('the signature depends on the path, not the host', () => {
    const onOtherHost = URL_A.replace('store.example', 'other.example');
    expect(verifyImageUrl(onOtherHost, signImageUrl(URL_A, SECRET), SECRET)).toBe(true);
  });
});
