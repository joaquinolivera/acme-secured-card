// Injectable clock so billing logic is testable. Tests replace `clock.now`.
export const clock = { now: (): Date => new Date() };

/** UTC business date as YYYY-MM-DD. */
export const toDate = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toDate(d);
}
