// Two laser processors instead of one (Dalton 2026-11-12: "a secondary container doing work like we did
// with uploadmycode"). Every call that reaches a processor joins this line in the Counters object first
// and is handed the least busy one; ties go to the first. So the second container only wakes while two
// jobs overlap (a class editing at once), and sleeps again on its own `sleepAfter` clock.
//
// A job that never says it finished (its Worker died) must not count as busy forever, or one container
// would look full and all work would pile onto the other: entries older than LINE_STALE_MS drop out.

/** Container names, index = what join() hands out. MUST be as long as `max_instances` for LaserContainer
 *  in wrangler.jsonc. Cloudflare counts every name ever used against that cap, so the first keeps the old
 *  default name (getContainer with no name) instead of a new one. */
export const PROCESSOR_NAMES = ['cf-singleton-container', 'laser-1'] as const;

/** The Worker gives up on a processor call after 35 s; a little longer and the entry is surely dead. */
export const LINE_STALE_MS = 45_000;

/** A runaway (or hostile) burst cannot grow the object without bound: past this many, the oldest go. */
export const MAX_IN_FLIGHT = 500;

export interface Ticket { token: string; container: number }

export class ProcessorLine {
  readonly #count: number;
  readonly #inFlight = new Map<string, { container: number; at: number }>(); // insertion order = age

  constructor(count: number = PROCESSOR_NAMES.length) {
    this.#count = Math.max(1, Math.floor(count));
  }

  /** Take a place: the least busy container, ties to the lower index. */
  join(token: string, now: number): Ticket {
    this.#expire(now);
    const busy = new Array<number>(this.#count).fill(0);
    for (const e of this.#inFlight.values()) busy[e.container]++;
    let container = 0;
    for (let i = 1; i < this.#count; i++) if (busy[i] < busy[container]) container = i;
    this.#inFlight.set(token, { container, at: now });
    while (this.#inFlight.size > MAX_IN_FLIGHT) this.#inFlight.delete(this.#inFlight.keys().next().value!);
    return { token, container };
  }

  /** The job finished (or failed): its place is free. An unknown token is fine (it already expired). */
  leave(token: string): void {
    this.#inFlight.delete(token);
  }

  /** Jobs in flight per container, for tests and logs. */
  busy(now: number): number[] {
    this.#expire(now);
    const busy = new Array<number>(this.#count).fill(0);
    for (const e of this.#inFlight.values()) busy[e.container]++;
    return busy;
  }

  #expire(now: number): void {
    for (const [token, e] of this.#inFlight) {
      if (now - e.at < LINE_STALE_MS) break; // the rest are younger
      this.#inFlight.delete(token);
    }
  }
}
