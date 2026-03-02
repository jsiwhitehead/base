export const DEV =
  typeof process !== "undefined" && process.env?.NODE_ENV
    ? process.env.NODE_ENV !== "production"
    : true;

export class CoreInvariantError extends Error {
  readonly code = "INVARIANT_VIOLATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "CoreInvariantError";
  }
}

export function isCoreInvariantError(err: unknown): err is CoreInvariantError {
  return err instanceof CoreInvariantError;
}

export function devAssert(cond: unknown, msg: string): asserts cond {
  if (DEV && !cond) throw new CoreInvariantError(msg);
}

export function devWarn(...args: unknown[]): void {
  if (DEV) console.warn(...args);
}
