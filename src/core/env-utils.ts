/** Shared environment-variable helpers used across strategy modules. */

/**
 * Read an env var as a number.  Returns `fallback` when the var is absent,
 * empty, or non-numeric.
 */
export function readEnvPct(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read an env var as an integer.  Returns `fallback` when the var is absent,
 * empty, non-numeric, or fails the optional `validate` check.  A blank value
 * (e.g. `KEY=` in .env) resolves to the default, never NaN.
 */
export function readEnvInt(
  key: string,
  fallback: number,
  validate: (n: number) => boolean = () => true,
): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && validate(parsed) ? parsed : fallback;
}

/**
 * Coerce a loosely-typed value (boolean | number | string | null | undefined)
 * to a boolean.  Truthy strings: "true", "1", "yes" (case-insensitive).
 */
export function toBooleanFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  return ["true", "1", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}
