import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCESS_PHASE, createAuthLifecycle } from '../src/auth-lifecycle.js';

const session = { user: { id: 'user-1', email: 'researcher@example.com' } };

test('unauthenticated transition does not authorize or initialize the Explorer', async () => {
  let authorizationCalls = 0;
  let mountCalls = 0;
  const lifecycle = createAuthLifecycle({
    authorize: async () => { authorizationCalls += 1; },
    mountProtected: async () => { mountCalls += 1; },
  });

  await lifecycle.transitionSession(null);

  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.UNAUTHENTICATED);
  assert.equal(authorizationCalls, 0);
  assert.equal(mountCalls, 0);
});

test('authenticated account without membership remains unauthorized and unmounted', async () => {
  let mountCalls = 0;
  const lifecycle = createAuthLifecycle({
    authorize: async () => null,
    mountProtected: async () => { mountCalls += 1; },
  });

  await lifecycle.transitionSession(session);

  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.UNAUTHORIZED);
  assert.equal(lifecycle.getState().session.user.email, 'researcher@example.com');
  assert.equal(mountCalls, 0);
});

test('restored session for an authorized member initializes the protected Explorer once', async () => {
  const phases = [];
  let mountCalls = 0;
  const member = { user_id: 'user-1', email: 'researcher@example.com' };
  const lifecycle = createAuthLifecycle({
    authorize: async () => member,
    mountProtected: async ({ session: activeSession, member: activeMember, isCurrent }) => {
      mountCalls += 1;
      assert.equal(activeSession.user.id, 'user-1');
      assert.equal(activeMember, member);
      assert.equal(isCurrent(), true);
      return () => {};
    },
    onStateChange: ({ phase }) => phases.push(phase),
  });

  await lifecycle.transitionSession(session);
  await lifecycle.transitionSession(session);

  assert.deepEqual(phases, [ACCESS_PHASE.AUTHORIZING, ACCESS_PHASE.INITIALIZING, ACCESS_PHASE.AUTHORIZED]);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.AUTHORIZED);
  assert.equal(mountCalls, 1);
});

test('password recovery blocks protected initialization until reset completion', async () => {
  let authorizationCalls = 0;
  let mountCalls = 0;
  const lifecycle = createAuthLifecycle({
    authorize: async () => {
      authorizationCalls += 1;
      return { user_id: 'user-1' };
    },
    mountProtected: async () => {
      mountCalls += 1;
      return () => {};
    },
  });

  lifecycle.enterRecovery(session);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.RECOVERY);
  assert.equal(authorizationCalls, 0);
  assert.equal(mountCalls, 0);

  await lifecycle.transitionSession(session);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.AUTHORIZED);
  assert.equal(authorizationCalls, 1);
  assert.equal(mountCalls, 1);
});

test('sign-out unmounts protected state and invalidates pending authorization', async () => {
  let cleanupCalls = 0;
  let resolveMembership;
  const pendingMembership = new Promise((resolve) => { resolveMembership = resolve; });
  const lifecycle = createAuthLifecycle({
    authorize: async (userId) => userId === 'pending-user'
      ? pendingMembership
      : { user_id: userId },
    mountProtected: async () => () => { cleanupCalls += 1; },
  });

  await lifecycle.transitionSession(session);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.AUTHORIZED);
  await lifecycle.transitionSession(null);
  assert.equal(cleanupCalls, 1);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.UNAUTHENTICATED);

  const pending = lifecycle.transitionSession({ user: { id: 'pending-user' } });
  await lifecycle.transitionSession(null);
  resolveMembership({ user_id: 'pending-user' });
  await pending;

  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.UNAUTHENTICATED);
  assert.equal(cleanupCalls, 1);
});

test('sign-out during asynchronous initialization disposes the stale protected mount', async () => {
  let resolveMount;
  let staleCleanupCalls = 0;
  const pendingMount = new Promise((resolve) => { resolveMount = resolve; });
  const lifecycle = createAuthLifecycle({
    authorize: async () => ({ user_id: 'user-1' }),
    mountProtected: async () => pendingMount,
  });

  const authorization = lifecycle.transitionSession(session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.INITIALIZING);

  await lifecycle.transitionSession(null);
  resolveMount(() => { staleCleanupCalls += 1; });
  await authorization;

  assert.equal(staleCleanupCalls, 1);
  assert.equal(lifecycle.getState().phase, ACCESS_PHASE.UNAUTHENTICATED);
});
