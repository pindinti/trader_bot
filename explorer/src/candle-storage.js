export const CANDLE_BUCKET = 'trade-bot-candles';

export class CandleStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CandleStorageError';
    this.code = code;
  }
}

export function validateCandleObjectPath(objectPath) {
  if (
    typeof objectPath !== 'string'
    || !objectPath
    || objectPath.startsWith('/')
    || objectPath.includes('\\')
    || objectPath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new CandleStorageError('invalid-path', 'Referência de dados privados inválida.');
  }
  return objectPath;
}

function storageFailure(error) {
  const parsedStatusCode = Number(error?.statusCode);
  const status = Number.isFinite(parsedStatusCode) ? parsedStatusCode : Number(error?.status);
  const code = `${error?.statusCode ?? ''} ${error?.code ?? ''}`.toLowerCase();
  if (status === 401 || status === 403 || code.includes('unauthorized') || code.includes('accessdenied')) {
    return new CandleStorageError(
      'access-denied',
      'Sua sessão expirou ou sua conta não tem acesso aos candles privados.',
      { cause: error },
    );
  }
  if (status === 404 || code.includes('not_found') || code.includes('not-found') || code.includes('nosuchkey')) {
    return new CandleStorageError(
      'missing-object',
      'Um arquivo necessário de candles não foi encontrado no armazenamento privado.',
      { cause: error },
    );
  }
  return new CandleStorageError(
    'storage-unavailable',
    'Não foi possível carregar os candles privados. Tente novamente.',
    { cause: error },
  );
}

export async function downloadPrivateJson(storage, objectPath) {
  const safePath = validateCandleObjectPath(objectPath);
  const { data, error } = await storage.from(CANDLE_BUCKET).download(safePath);
  if (error) throw storageFailure(error);
  if (!data || typeof data.text !== 'function') {
    throw new CandleStorageError('invalid-object', 'O armazenamento retornou um arquivo de candles inválido.');
  }
  try {
    return JSON.parse(await data.text());
  } catch (error) {
    throw new CandleStorageError(
      'invalid-json',
      'Um arquivo privado de candles contém JSON inválido.',
      { cause: error },
    );
  }
}
