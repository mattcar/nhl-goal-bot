/**
 * Eastern Time helpers. The NHL schedule and "today" boundaries are ET-based,
 * so every day comparison goes through IANA America/New_York — never a
 * hand-rolled UTC offset (which breaks during daylight saving time).
 */

const ET = 'America/New_York';

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const fullFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  month: 'numeric',
  day: 'numeric',
  year: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZoneName: 'short',
});

const asDate = (value) => (value instanceof Date ? value : new Date(value));

/** "2025-1-15" style key for the ET calendar day containing `value`. */
export function etDayKey(value = new Date()) {
  const parts = Object.fromEntries(
    dayFmt.formatToParts(asDate(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True when both values fall on the same ET calendar day. */
export function isSameETDay(a, b = new Date()) {
  return etDayKey(a) === etDayKey(b);
}

/** Human-readable ET timestamp for logs. */
export function formatET(value = new Date()) {
  return fullFmt.format(asDate(value));
}

/** Whole minutes elapsed since `timestamp`. */
export function ageMinutes(timestamp, now = Date.now()) {
  return Math.round((now - Number(asDate(timestamp))) / 60_000);
}
