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

export function unauthorized(): AppError {
  return new AppError(401, 'unauthorized', 'A valid API key is required');
}

export function forbidden(): AppError {
  return new AppError(403, 'forbidden', 'This API key does not allow the operation');
}

export function notFound(resource: string): AppError {
  return new AppError(404, 'not_found', `${resource} not found`);
}

export function tooManyRequests(): AppError {
  return new AppError(429, 'rate_limited', 'Rate limit exceeded');
}
