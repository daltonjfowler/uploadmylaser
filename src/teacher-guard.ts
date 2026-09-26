// The one guard on the teacher key: a coarse ceiling on WRONG keys from everybody together
// (a port of uploadmycode's). No per-IP lockouts: a school shares one public IP, so a per-IP
// penalty would let one student lock out the whole class, or the teacher.
//
//   more than 100 wrong keys from everyone inside 15 minutes
//     -> wrong keys get 429 for the next 15 minutes
//     -> a CORRECT key always works (the Worker compares the key first and only asks this guard
//        about keys that were already wrong)
//
// Lives in the Counters Durable Object, in memory. Pure apart from the clock.

export const GLOBAL_TEACHER_MAX_FAILURES = 100;
export const GLOBAL_TEACHER_WINDOW_MS = 15 * 60_000;
export const GLOBAL_TEACHER_LOCK_MS = 15 * 60_000;

export interface GuardVerdict {
  locked: boolean;
  retryAfterSeconds: number; // 0 when not armed
  retryAfterMinutes: number; // never 0 while armed
}

export function minutesPhrase(v: { retryAfterMinutes: number }): string {
  return v.retryAfterMinutes === 1 ? '1 minute' : `${v.retryAfterMinutes} minutes`;
}

export class TeacherKeyGuard {
  #at: number[] = []; // wrong keys inside the window, oldest first
  #until = 0; // unix ms the guard lifts, 0 when not armed

  recordFailure(now: number): GuardVerdict {
    // Already armed: do not count and do not extend, or retries would keep it armed forever.
    if (this.#until > now) return this.#verdict(now);
    if (this.#until !== 0) {
      this.#until = 0;
      this.#at = [];
    }
    const cutoff = now - GLOBAL_TEACHER_WINDOW_MS;
    this.#at = this.#at.filter((at) => at > cutoff);
    this.#at.push(now);
    if (this.#at.length > GLOBAL_TEACHER_MAX_FAILURES) this.#until = now + GLOBAL_TEACHER_LOCK_MS;
    return this.#verdict(now);
  }

  get failures(): number {
    return this.#at.length;
  }

  #verdict(now: number): GuardVerdict {
    if (this.#until <= now) return { locked: false, retryAfterSeconds: 0, retryAfterMinutes: 0 };
    const seconds = Math.max(1, Math.ceil((this.#until - now) / 1000));
    return { locked: true, retryAfterSeconds: seconds, retryAfterMinutes: Math.max(1, Math.ceil(seconds / 60)) };
  }
}
