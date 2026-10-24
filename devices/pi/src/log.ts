/**
 * Plain one-line logs to stdout (journald keeps them on the Pi). Never pass a credential, a header, audio,
 * a transcript or a model reply here: fields whose names look secret are redacted as a backstop, not as the
 * main protection.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SECRET_FIELD = /credential|token|secret|authorization|password|audio|wav/i;

export function formatFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${SECRET_FIELD.test(key) ? "[redacted]" : JSON.stringify(value)}`)
    .map((pair) => ` ${pair}`)
    .join("");
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const at = (level: string) => (message: string, fields?: LogFields) =>
    write(`${new Date().toISOString()} ${level} ${message}${formatFields(fields)}`);
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
