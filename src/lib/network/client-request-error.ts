export function buildClientRequestErrorDetails(input: {
  route: string;
  method?: string;
  error: unknown;
  extra?: Record<string, unknown>;
}) {
  const error = input.error;
  const online =
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : null;

  if (error instanceof Error) {
    const cause =
      'cause' in error && error.cause && typeof error.cause === 'object'
        ? (error.cause as Record<string, unknown>)
        : null;

    return {
      route: input.route,
      method: input.method ?? 'GET',
      online,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
      errorCause:
        typeof error.cause === 'string'
          ? error.cause
          : cause && typeof cause.message === 'string'
            ? cause.message
            : null,
      errorCode: cause && typeof cause.code === 'string' ? cause.code : null,
      errorErrno: cause && typeof cause.errno === 'number' ? cause.errno : null,
      errorSyscall: cause && typeof cause.syscall === 'string' ? cause.syscall : null,
      errorAddress: cause && typeof cause.address === 'string' ? cause.address : null,
      errorPort: cause && typeof cause.port === 'number' ? cause.port : null,
      ...(input.extra ?? {}),
    };
  }

  return {
    route: input.route,
    method: input.method ?? 'GET',
    online,
    errorName: 'UnknownError',
    errorMessage:
      typeof error === 'string'
        ? error
        : error && typeof error === 'object'
          ? JSON.stringify(error)
          : String(error),
    errorStack: null,
    errorCause: null,
    errorCode: null,
    errorErrno: null,
    errorSyscall: null,
    errorAddress: null,
    errorPort: null,
    ...(input.extra ?? {}),
  };
}

export function logClientRequestError(input: {
  label: string;
  route: string;
  method?: string;
  error: unknown;
  extra?: Record<string, unknown>;
}) {
  console.error(
    input.label,
    buildClientRequestErrorDetails({
      route: input.route,
      method: input.method,
      error: input.error,
      extra: input.extra,
    }),
  );
}
