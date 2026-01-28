export const DEV =
  typeof process !== "undefined" && process.env?.NODE_ENV
    ? process.env.NODE_ENV !== "production"
    : true;

export function devAssert(cond: unknown, msg: string): asserts cond {
  if (DEV && !cond) throw new Error(msg);
}

export function devWarn(...args: unknown[]) {
  if (DEV) console.warn(...args);
}
