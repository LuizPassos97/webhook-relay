/**
 * An expected failure that maps to an HTTP status code.
 * The message is safe to return to API clients; it must never contain secrets.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string): AppError {
  return new AppError(400, 'invalid_request', message);
}

export function conflict(message: string): AppError {
  return new AppError(409, 'conflict', message);
}

export function payloadTooLarge(message: string): AppError {
  return new AppError(413, 'payload_too_large', message);
}
