const formatters = new Map<string, Intl.DateTimeFormat>();

export function localDateKey(at: number | Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

/** Split a short, evidenced interval at the local midnight, including DST changes.
 * Binary search runs only when an interval crosses a date boundary (at most once
 * for the tracker's <=60-second intervals), without assuming 24-hour local days.
 */
export function splitByDay(from: number, to: number, timeZone: string): Array<{ date: string; activeMs: number }> {
  if (to <= from) return [];
  const date = localDateKey(from, timeZone);
  if (date === localDateKey(to - 1, timeZone)) return [{ date, activeMs: to - from }];
  let low = from;
  let high = to;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateKey(middle, timeZone) === date) low = middle;
    else high = middle;
  }
  return [{ date, activeMs: high - from }, ...splitByDay(high, to, timeZone)];
}
