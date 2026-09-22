import './styles.css';
import { cleanAuthCallbackUrl, inspectAuthCallback } from './auth-callback.js';
import { ACCESS_PHASE, createAuthLifecycle } from './auth-lifecycle.js';
import {
  currentSession,
  getMembership,
  onAuthStateChange,
  requestPasswordRecovery,
  signInWithPassword,
  signOut,
  supabaseConfigured,
  updatePassword,
} from './supabase.js';

const authRoot = document.querySelector('#authRoot');
const protectedRoot = document.querySelector('#protectedRoot');
const explorerTemplate = document.querySelector('#explorerTemplate');
const accessTitle = document.querySelector('#accessTitle');
const accessDescription = document.querySelector('#accessDescription');
const sessionProgress = document.querySelector('#sessionProgress');
const loginForm = document.querySelector('#loginForm');
const recoveryForm = document.querySelector('#recoveryForm');
const signInButton = document.querySelector('#signInButton');
const recoveryRequestButton = document.querySelector('#recoveryRequestButton');
const updatePasswordButton = document.querySelector('#updatePasswordButton');
const cancelRecoveryButton = document.querySelector('#cancelRecoveryButton');
const accessActions = document.querySelector('#accessActions');
const accessState = document.querySelector('#accessState');
const signOutButton = document.querySelector('#signOutButton');

const RECOVERY_PENDING_KEY = 'trade-bot:password-recovery-pending';
const callbackInfo = inspectAuthCallback(window.location.href);
const recoveryPendingAtLoad = (() => {
  try { return sessionStorage.getItem(RECOVERY_PENDING_KEY) === 'true'; }
  catch { return false; }
})();
let recoveryGate = callbackInfo.expectsRecovery || Boolean(callbackInfo.error) || recoveryPendingAtLoad;
let recoveryEventReceived = false;
let recoveryFailureTimer = null;

function setRecoveryPending(pending) {
  try {
    if (pending) sessionStorage.setItem(RECOVERY_PENDING_KEY, 'true');
    else sessionStorage.removeItem(RECOVERY_PENDING_KEY);
  } catch { /* The live recovery event still gates this page load. */ }
}

function clearCallbackLocation() {
  window.history.replaceState({}, document.title, cleanAuthCallbackUrl(window.location.href));
}

function authErrorMessage(error, action) {
  if (error?.code === 'invalid_credentials') return 'E-mail ou senha inválidos.';
  if (error?.code === 'email_not_confirmed') return 'Confirme seu e-mail antes de entrar.';
  if (error?.code === 'over_request_rate_limit') return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  return `${action}: ${error?.message || 'erro inesperado.'}`;
}

function renderAccess(state) {
  if (state.phase !== ACCESS_PHASE.AUTHORIZED) protectedRoot.replaceChildren();
  const protectedPhase = [ACCESS_PHASE.INITIALIZING, ACCESS_PHASE.AUTHORIZED].includes(state.phase);
  authRoot.hidden = protectedPhase;
  protectedRoot.hidden = !protectedPhase;
  loginForm.hidden = true;
  recoveryForm.hidden = true;
  accessActions.hidden = true;
  sessionProgress.hidden = true;
  accessState.className = 'access-state';
  accessState.textContent = '';

  if (state.phase === ACCESS_PHASE.RESTORING) {
    accessTitle.innerHTML = recoveryGate
      ? 'Validando<br /><em>recuperação.</em>'
      : 'Restaurando<br /><em>seu acesso.</em>';
    accessDescription.textContent = recoveryGate
      ? 'Estamos validando o link antes de permitir a definição de uma nova senha.'
      : 'Estamos verificando a sessão salva neste navegador.';
    sessionProgress.hidden = false;
    return;
  }
  if (state.phase === ACCESS_PHASE.UNAUTHENTICATED) {
    accessTitle.innerHTML = 'Entre no<br /><em>Explorer.</em>';
    accessDescription.textContent = 'Um ambiente privado para revisar movimentos de mercado, desenhos e análises compartilhadas entre pesquisadores autorizados.';
    loginForm.hidden = false;
    signInButton.disabled = !supabaseConfigured;
    recoveryRequestButton.disabled = !supabaseConfigured;
    if (!supabaseConfigured) {
      accessState.classList.add('error');
      accessState.textContent = 'Autenticação indisponível: configure as variáveis públicas do Supabase.';
    }
    return;
  }
  if (state.phase === ACCESS_PHASE.RECOVERY) {
    accessTitle.innerHTML = 'Defina uma<br /><em>nova senha.</em>';
    accessDescription.textContent = 'O link foi validado. Escolha uma nova senha para a conta existente; seu histórico e sua autorização serão preservados.';
    recoveryForm.hidden = false;
    accessState.textContent = state.session?.user?.email ? `Conta: ${state.session.user.email}` : '';
    return;
  }
  if (state.phase === ACCESS_PHASE.RECOVERY_ERROR) {
    accessTitle.innerHTML = 'Link inválido<br /><em>ou expirado.</em>';
    accessDescription.textContent = 'Solicite um novo link de recuperação usando o e-mail da sua conta existente.';
    loginForm.hidden = false;
    accessState.classList.add('error');
    accessState.textContent = state.error?.message || 'Não foi possível validar o link de recuperação.';
    return;
  }
  if (state.phase === ACCESS_PHASE.AUTHORIZING || state.phase === ACCESS_PHASE.INITIALIZING) {
    accessTitle.innerHTML = state.phase === ACCESS_PHASE.AUTHORIZING
      ? 'Verificando<br /><em>autorização.</em>'
      : 'Preparando<br /><em>o Explorer.</em>';
    accessDescription.textContent = state.phase === ACCESS_PHASE.AUTHORIZING
      ? 'Sua identidade foi confirmada. Agora estamos consultando a lista privada de pesquisadores.'
      : 'Acesso autorizado. Carregando o ambiente de análise e os dados auditados.';
    sessionProgress.querySelector('span:last-child').textContent = state.phase === ACCESS_PHASE.AUTHORIZING
      ? 'Consultando autorização…'
      : 'Inicializando o ambiente protegido…';
    sessionProgress.hidden = false;
    return;
  }
  if (state.phase === ACCESS_PHASE.UNAUTHORIZED) {
    accessTitle.innerHTML = 'Acesso<br /><em>restrito.</em>';
    accessDescription.textContent = 'Esta conta está autenticada, mas não consta na lista de pesquisadores autorizados.';
    accessActions.hidden = false;
    accessState.textContent = state.session?.user?.email
      ? `Conta atual: ${state.session.user.email}`
      : 'Use outra conta que tenha sido incluída em research_members.';
    return;
  }
  if (state.phase === ACCESS_PHASE.ERROR) {
    accessTitle.innerHTML = 'Não foi possível<br /><em>validar o acesso.</em>';
    accessDescription.textContent = 'O Explorer permaneceu fechado porque a autenticação ou a consulta de autorização falhou.';
    accessState.classList.add('error');
    accessState.textContent = state.error?.message || 'Tente novamente ou encerre a sessão atual.';
    if (state.session) accessActions.hidden = false;
    else loginForm.hidden = false;
  }
}

async function requestSignOut() {
  recoveryGate = false;
  setRecoveryPending(false);
  clearTimeout(recoveryFailureTimer);
  await signOut();
  await lifecycle.transitionSession(null);
}

const lifecycle = createAuthLifecycle({
  authorize: getMembership,
  onStateChange: renderAccess,
  mountProtected: async ({ session, member, isCurrent }) => {
    const { createExplorer } = await import('./explorer.js');
    if (!isCurrent()) return () => {};
    return createExplorer({
      root: protectedRoot,
      template: explorerTemplate,
      session,
      member,
      onSignOut: requestSignOut,
      isCurrent,
    });
  },
});

async function handleAuthEvent(event, session) {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryGate = true;
    recoveryEventReceived = true;
    setRecoveryPending(true);
    clearTimeout(recoveryFailureTimer);
    lifecycle.enterRecovery(session);
    clearCallbackLocation();
    return;
  }
  if (recoveryGate) {
    if (event === 'SIGNED_OUT' && lifecycle.getState().phase === ACCESS_PHASE.RECOVERY) {
      setRecoveryPending(false);
      lifecycle.failRecovery(new Error('A sessão de recuperação expirou. Solicite um novo link.'));
    } else if (event === 'INITIAL_SESSION' && callbackInfo.expectsRecovery && !recoveryEventReceived) {
      recoveryFailureTimer = setTimeout(() => {
        if (!recoveryEventReceived) {
          setRecoveryPending(false);
          clearCallbackLocation();
          lifecycle.failRecovery(new Error('O link de recuperação é inválido ou expirou. Solicite outro link.'));
        }
      }, 0);
    }
    return;
  }
  await lifecycle.transitionSession(session);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;
  recoveryGate = false;
  setRecoveryPending(false);
  clearTimeout(recoveryFailureTimer);
  clearCallbackLocation();
  signInButton.disabled = true;
  recoveryRequestButton.disabled = true;
  signInButton.textContent = 'Entrando…';
  accessState.className = 'access-state';
  accessState.textContent = 'Validando suas credenciais…';
  try {
    const session = await signInWithPassword(loginForm.elements.email.value, loginForm.elements.password.value);
    await lifecycle.transitionSession(session);
  } catch (error) {
    accessState.classList.add('error');
    accessState.textContent = authErrorMessage(error, 'Não foi possível entrar');
  } finally {
    loginForm.elements.password.value = '';
    signInButton.disabled = !supabaseConfigured;
    recoveryRequestButton.disabled = !supabaseConfigured;
    signInButton.textContent = 'Entrar';
  }
});

recoveryRequestButton.addEventListener('click', async () => {
  const emailInput = loginForm.elements.email;
  if (!emailInput.reportValidity()) return;
  recoveryRequestButton.disabled = true;
  signInButton.disabled = true;
  recoveryRequestButton.textContent = 'Enviando…';
  accessState.className = 'access-state';
  accessState.textContent = 'Solicitando um link de recuperação…';
  try {
    await requestPasswordRecovery(emailInput.value);
    accessState.classList.add('success');
    accessState.textContent = 'Se esse e-mail pertencer a uma conta existente, enviaremos um link para definir uma nova senha.';
  } catch (error) {
    accessState.classList.add('error');
    accessState.textContent = authErrorMessage(error, 'Não foi possível enviar o link');
  } finally {
    recoveryRequestButton.disabled = !supabaseConfigured;
    signInButton.disabled = !supabaseConfigured;
    recoveryRequestButton.textContent = 'Definir ou recuperar senha';
  }
});

recoveryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!recoveryForm.reportValidity()) return;
  const password = recoveryForm.elements.password.value;
  if (password !== recoveryForm.elements.passwordConfirmation.value) {
    accessState.className = 'access-state error';
    accessState.textContent = 'As senhas não coincidem.';
    return;
  }
  updatePasswordButton.disabled = true;
  cancelRecoveryButton.disabled = true;
  updatePasswordButton.textContent = 'Salvando…';
  accessState.className = 'access-state';
  accessState.textContent = 'Atualizando a senha da conta existente…';
  try {
    const expectedUserId = lifecycle.getState().session?.user?.id;
    await updatePassword(password);
    const session = await currentSession();
    if (!session?.user?.id || session.user.id !== expectedUserId) throw new Error('A sessão de recuperação não é mais válida.');
    recoveryGate = false;
    setRecoveryPending(false);
    clearCallbackLocation();
    recoveryForm.reset();
    await lifecycle.transitionSession(session);
  } catch (error) {
    accessState.classList.add('error');
    accessState.textContent = authErrorMessage(error, 'Não foi possível atualizar a senha');
  } finally {
    updatePasswordButton.disabled = false;
    cancelRecoveryButton.disabled = false;
    updatePasswordButton.textContent = 'Salvar nova senha';
  }
});

cancelRecoveryButton.addEventListener('click', async () => {
  cancelRecoveryButton.disabled = true;
  try {
    await requestSignOut();
    recoveryForm.reset();
    clearCallbackLocation();
  } catch (error) {
    accessState.className = 'access-state error';
    accessState.textContent = authErrorMessage(error, 'Não foi possível encerrar a recuperação');
  } finally {
    cancelRecoveryButton.disabled = false;
  }
});

signOutButton.addEventListener('click', async () => {
  signOutButton.disabled = true;
  accessState.textContent = 'Encerrando sessão…';
  try {
    await requestSignOut();
  } catch (error) {
    accessState.className = 'access-state error';
    accessState.textContent = authErrorMessage(error, 'Não foi possível sair');
  } finally {
    signOutButton.disabled = false;
  }
});

renderAccess(lifecycle.getState());
onAuthStateChange((event, session) => { void handleAuthEvent(event, session); });

if (callbackInfo.error) {
  setRecoveryPending(false);
  lifecycle.failRecovery(callbackInfo.error);
  clearCallbackLocation();
} else {
  try {
    const session = await currentSession();
    if (recoveryPendingAtLoad) {
      if (session?.user?.id) lifecycle.enterRecovery(session);
      else lifecycle.failRecovery(new Error('A sessão de recuperação expirou. Solicite um novo link.'));
    } else if (!recoveryGate) {
      await lifecycle.transitionSession(session);
    }
  } catch (error) {
    if (recoveryGate) lifecycle.failRecovery(error);
    else renderAccess({ phase: ACCESS_PHASE.ERROR, session: null, member: null, error });
  }
}
