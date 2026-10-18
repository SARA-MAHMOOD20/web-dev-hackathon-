/** An error whose message is safe and useful to show the user. */
export class UserError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** A failed call to an external provider. `retryable` = temporary (429, 5xx, network). */
export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean, public httpStatus?: number) {
    super(message);
  }
}

export const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/** I5.5: retry temporary failures with a growing delay (0.5 s, 1 s); permanent ones fail at once. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : e instanceof TypeError; // TypeError = fetch network failure
      if (!retryable || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}
