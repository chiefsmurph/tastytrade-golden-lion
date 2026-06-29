const DEFAULT_SECRET_AUTO_SEED_START_MINUTE = 6 * 60 + 30;
const CASH_ACCOUNT_SEED_END_MINUTE = 13 * 60;

function parseMinuteOfDay(value: string | undefined): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);
  if (!match) {
    return null;
  }

  const [hoursText, minutesText] = trimmed.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function getMinuteOfDay(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

export function getSecretAutoSeedWindowStartMinute(): number {
  return (
    parseMinuteOfDay(process.env.SECRET_AUTO_SEED_START_TIME) ??
    DEFAULT_SECRET_AUTO_SEED_START_MINUTE
  );
}

export function getCashAccountSeedEndMinute(): number {
  return CASH_ACCOUNT_SEED_END_MINUTE;
}

export function isWithinSecretAutoSeedWindow(currentTime: Date): boolean {
  const minuteOfDay = getMinuteOfDay(currentTime);
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();

  return minuteOfDay >= startMinute && minuteOfDay <= endMinute;
}

export function isWithinCashAccountSeedFromMarginWindow(currentTime: Date): boolean {
  return getMinuteOfDay(currentTime) < getCashAccountSeedEndMinute();
}