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
 * Read an env var that expresses a PERCENT-OF-something as a normalized
 * FRACTION (0..1-ish).  This is the unit-robust reader for the sizing / cap
 * knobs whose in-code defaults are fractions (0.12, 0.25, 0.60) but whose
 * server `.env` values are frequently written as integer-looking percents
 * (`12`, `25`, `60`).  Without this, `readEnvPct("...=12", 0.12)` would return
 * the raw `12` (= 1200%) and blow the sizing band the moment it went live.
 *
 * Rule: a value `> 1` is interpreted as a percent and divided by 100 (`12` →
 * `0.12`, `60` → `0.60`); a value `<= 1` is already a fraction and passes
 * through unchanged (`0.12` → `0.12`).  This makes BOTH conventions safe, so a
 * human can write either form.  The `1` boundary is inclusive-as-fraction:
 * `1` means 100% (a full fraction), which is the only sensible reading for
 * these knobs (a literal 1% cap would be nonsensical here).  Absent / blank /
 * non-numeric / non-positive resolves to `fallback` (also treated as already a
 * fraction — pass fractional defaults).
 */
export function readEnvFraction(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > 1 ? parsed / 100 : parsed;
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
