const CALLBACK_KEYS = ['code', 'error', 'error_code', 'error_description', 'type'];

export function resolveApplicationUrl(origin, basePath) {
  if (typeof basePath !== 'string' || !basePath.startsWith('/') || !basePath.endsWith('/')) {
    throw new TypeError('Invalid application base path.');
  }
  return new URL(basePath, `${new URL(origin).origin}/`).href;
}

export function inspectAuthCallback(url) {
  const parsed = new URL(url);
  const query = parsed.searchParams;
  const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  const value = (key) => hash.get(key) ?? query.get(key);
  const type = value('type');
  const errorCode = value('error_code') ?? value('error');
  const errorDescription = value('error_description');
  return {
    expectsRecovery: type === 'recovery',
    error: errorCode
      ? new Error(errorDescription || `O link de recuperação não pôde ser validado (${errorCode}).`)
      : null,
  };
}

export function cleanAuthCallbackUrl(url) {
  const parsed = new URL(url);
  CALLBACK_KEYS.forEach((key) => parsed.searchParams.delete(key));
  parsed.hash = '';
  return `${parsed.pathname}${parsed.search}`;
}
