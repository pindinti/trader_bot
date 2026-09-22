import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanAuthCallbackUrl, inspectAuthCallback, resolveApplicationUrl } from '../src/auth-callback.js';

test('resolves recovery redirects against the configured application base', () => {
  assert.equal(
    resolveApplicationUrl('https://pindinti.github.io', '/trader_bot/'),
    'https://pindinti.github.io/trader_bot/',
  );
  assert.equal(resolveApplicationUrl('http://localhost:5173', '/'), 'http://localhost:5173/');
});

test('recognizes recovery callbacks without returning session credentials', () => {
  const result = inspectAuthCallback('http://localhost:5173/#access_token=secret&type=recovery&refresh_token=secret-two');
  assert.deepEqual(Object.keys(result), ['expectsRecovery', 'error']);
  assert.equal(result.expectsRecovery, true);
  assert.equal(result.error, null);
});

test('reports expired recovery links and removes callback parameters from the visible URL', () => {
  const url = 'http://localhost:5173/?error=access_denied&error_code=otp_expired&error_description=Link+expired#access_token=secret';
  const result = inspectAuthCallback(url);
  assert.equal(result.error.message, 'Link expired');
  assert.equal(cleanAuthCallbackUrl(url), '/');
});
