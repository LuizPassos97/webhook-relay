export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Writes one JSON object per line, the same shape the API's logger produces.
 * Callers must only pass identifiers and outcomes, never payloads or secrets.
 */
export function createJsonLogger(stream: NodeJS.WritableStream = process.stdout): Logger {
  const write = (level: 'info' | 'error', message: string, fields: LogFields = {}) => {
    stream.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`,
    );
  };
  return {
    info: (message, fields) => {
      write('info', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** Extracts a loggable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
