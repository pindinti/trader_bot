export const ACCESS_PHASE = Object.freeze({
  RESTORING: 'restoring',
  UNAUTHENTICATED: 'unauthenticated',
  AUTHORIZING: 'authorizing',
  INITIALIZING: 'initializing',
  AUTHORIZED: 'authorized',
  UNAUTHORIZED: 'unauthorized',
  RECOVERY: 'recovery',
  RECOVERY_ERROR: 'recovery-error',
  ERROR: 'error',
});

export function createAuthLifecycle({ authorize, mountProtected, onStateChange = () => {} }) {
  let generation = 0;
  let cleanup = null;
  let state = { phase: ACCESS_PHASE.RESTORING, session: null, member: null, error: null };

  const emit = (next) => {
    state = Object.freeze(next);
    onStateChange(state);
  };

  const unmount = () => {
    const currentCleanup = cleanup;
    cleanup = null;
    currentCleanup?.();
  };

  async function transitionSession(session) {
    const userId = session?.user?.id ?? null;
    const currentUserId = state.session?.user?.id ?? null;
    if (userId && userId === currentUserId && [
      ACCESS_PHASE.AUTHORIZING,
      ACCESS_PHASE.INITIALIZING,
      ACCESS_PHASE.AUTHORIZED,
    ].includes(state.phase)) return state;

    const transitionGeneration = ++generation;
    unmount();

    if (!userId) {
      emit({ phase: ACCESS_PHASE.UNAUTHENTICATED, session: null, member: null, error: null });
      return state;
    }

    emit({ phase: ACCESS_PHASE.AUTHORIZING, session, member: null, error: null });
    let member;
    try {
      member = await authorize(userId);
    } catch (error) {
      if (transitionGeneration === generation) {
        emit({ phase: ACCESS_PHASE.ERROR, session, member: null, error });
      }
      return state;
    }

    if (transitionGeneration !== generation) return state;
    if (!member) {
      emit({ phase: ACCESS_PHASE.UNAUTHORIZED, session, member: null, error: null });
      return state;
    }

    emit({ phase: ACCESS_PHASE.INITIALIZING, session, member, error: null });
    try {
      const mountedCleanup = await mountProtected({
        session,
        member,
        isCurrent: () => transitionGeneration === generation,
      });
      if (transitionGeneration !== generation) {
        mountedCleanup?.();
        return state;
      }
      cleanup = mountedCleanup ?? null;
      emit({ phase: ACCESS_PHASE.AUTHORIZED, session, member, error: null });
    } catch (error) {
      if (transitionGeneration === generation) {
        unmount();
        emit({ phase: ACCESS_PHASE.ERROR, session, member: null, error });
      }
    }
    return state;
  }

  function enterRecovery(session) {
    generation += 1;
    unmount();
    if (!session?.user?.id) {
      emit({
        phase: ACCESS_PHASE.RECOVERY_ERROR,
        session: null,
        member: null,
        error: new Error('O link de recuperação não contém uma sessão válida.'),
      });
      return state;
    }
    emit({ phase: ACCESS_PHASE.RECOVERY, session, member: null, error: null });
    return state;
  }

  function failRecovery(error) {
    generation += 1;
    unmount();
    emit({
      phase: ACCESS_PHASE.RECOVERY_ERROR,
      session: null,
      member: null,
      error: error instanceof Error ? error : new Error(String(error || 'Link de recuperação inválido.')),
    });
    return state;
  }

  function dispose() {
    generation += 1;
    unmount();
  }

  return { transitionSession, enterRecovery, failRecovery, dispose, getState: () => state };
}
