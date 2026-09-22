import assert from 'node:assert/strict';
import test from 'node:test';

import {
  performPasswordRecovery,
  performPasswordSignIn,
  performPasswordUpdate,
} from '../src/auth-operations.js';

const session = { user: { id: 'user-1', email: 'researcher@example.com' } };

test('password sign-in delegates credentials to Supabase and returns its session', async () => {
  const calls = [];
  const auth = {
    signInWithPassword: async (credentials) => {
      calls.push(credentials);
      return { data: { session }, error: null };
    },
  };

  assert.equal(await performPasswordSignIn(auth, ' researcher@example.com ', 'secret-value'), session);
  assert.deepEqual(calls, [{ email: 'researcher@example.com', password: 'secret-value' }]);
});

test('password recovery uses the existing-account recovery endpoint and redirect URL', async () => {
  const calls = [];
  const auth = {
    resetPasswordForEmail: async (...args) => {
      calls.push(args);
      return { data: {}, error: null };
    },
  };

  await performPasswordRecovery(auth, 'researcher@example.com', 'http://localhost:5173/');
  assert.deepEqual(calls, [[
    'researcher@example.com',
    { redirectTo: 'http://localhost:5173/' },
  ]]);
});

test('recovered password is updated through the authenticated Supabase user', async () => {
  const calls = [];
  const auth = {
    updateUser: async (attributes) => {
      calls.push(attributes);
      return { data: { user: session.user }, error: null };
    },
  };

  assert.equal(await performPasswordUpdate(auth, 'new-secret'), session.user);
  assert.deepEqual(calls, [{ password: 'new-secret' }]);
});

test('Supabase authentication errors are propagated without fallback account creation', async () => {
  const expected = Object.assign(new Error('Invalid credentials'), { code: 'invalid_credentials' });
  const auth = {
    signInWithPassword: async () => ({ data: { session: null }, error: expected }),
  };
  await assert.rejects(performPasswordSignIn(auth, 'researcher@example.com', 'wrong'), expected);
});
