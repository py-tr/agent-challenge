/**
 * src/pulse/lib/userTimezone.ts
 *
 * Stores the user's local timezone detected from the browser (X-Timezone header).
 * Falls back to TZ env var, then system timezone, then UTC.
 *
 * Updated on every incoming HTTP request that carries the header.
 * Background services (MorningBriefing, DailySummary) read the stored value.
 */

let _tz: string =
  process.env.TZ ??
  Intl.DateTimeFormat().resolvedOptions().timeZone ??
  "UTC";

/** Called by route middleware whenever a request has X-Timezone header. */
export function setUserTimezone(tz: string): void {
  if (tz && tz !== _tz) {
    console.log(`[Pulse] User timezone detected: ${tz}`);
    _tz = tz;
  }
}

/** Returns the user's timezone string (IANA, e.g. "Europe/Prague"). */
export function getUserTimezone(): string {
  return _tz;
}

/**
 * Format a Date as YYYY-MM-DD in the user's local timezone.
 * Uses Intl.DateTimeFormat — works correctly regardless of server timezone.
 */
export function localYMD(d: Date = new Date(), tz: string = _tz): string {
  // en-CA locale produces YYYY-MM-DD which we can use directly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).format(d);
}

/**
 * Get the day-of-week index (0=Sun…6=Sat) for a Date in the user's timezone.
 */
export function localDayOfWeek(d: Date = new Date(), tz: string = _tz): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(d).toLowerCase();
  return ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(name);
}

/**
 * Get local hour (0-23) for a Date in the user's timezone.
 */
export function localHour(d: Date = new Date(), tz: string = _tz): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(d),
    10,
  );
}

/**
 * Format a Date as HH:MM in the user's timezone.
 */
export function localHM(d: Date = new Date(), tz: string = _tz): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
