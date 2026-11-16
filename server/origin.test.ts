import { expect, it } from 'vitest';
import { isAllowedOrigin } from './origin.ts';

it('allows loopback browser origins on any port and requests without an origin', () => {
  expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
  expect(isAllowedOrigin('http://localhost:5174')).toBe(true);
  expect(isAllowedOrigin('http://[::1]:5173')).toBe(true);
  expect(isAllowedOrigin(undefined)).toBe(true);
});
it('rejects external sites and lookalike loopback origins', () => {
  expect(isAllowedOrigin('https://example.com')).toBe(false);
  expect(isAllowedOrigin('http://127.0.0.1.evil.test:5173')).toBe(false);
  expect(isAllowedOrigin('https://localhost:5173')).toBe(false);
  expect(isAllowedOrigin('null')).toBe(false);
});
