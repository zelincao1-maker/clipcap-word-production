export function getRawErrorMessage(
  error: unknown,
  fallback = 'Unknown error',
): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }

  if (typeof error === 'string') {
    return error || fallback;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;

    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }

    if (
      typeof record.error_description === 'string' &&
      record.error_description.trim().length > 0
    ) {
      return record.error_description;
    }

    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }

  return String(error ?? fallback);
}
