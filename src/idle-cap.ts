// Backstop for the container's sleep clock.
//
// @cloudflare/containers will not let a container sleep while it counts a request as in flight,
// and it only stops counting once that response body has finished streaming. A body that never
// finishes, or a container that never answers, keeps the count above zero forever, so `sleepAfter`
// never fires. On 2026-11-09 that held the laser container awake (and billing memory) from about
// noon to 5 pm with no one using it. (askProcessor's timeout gives up on a call but cannot cancel it,
// so an abandoned call still counts.)
//
// The rule here does not trust that count: if no new request has reached the container for
// IDLE_CAP_MS, stop it. No real request can need that long, because the Worker gives up on every
// container call after CONTAINER_TIMEOUT_MS (35 s). The container is stateless (each job is its own
// request), so stopping it loses nothing. Stop is SIGTERM first; if it is still up on a later alarm,
// SIGKILL.

export const CONTAINER_TIMEOUT_MS = 35_000; // the Worker gives up on a container call after this (runner.py stops jobs at 30 s)
export const SLEEP_AFTER_MS = 5 * 60_000; // the normal sleep clock (`sleepAfter = '5m'`)
export const IDLE_CAP_MS = 10 * 60_000;
/** SIGTERM had this long and the container is still up: SIGKILL. uvicorn exits within 5 s of SIGTERM
 *  (`--timeout-graceful-shutdown 5` in container/Dockerfile), so this only fires on a real hang. */
export const KILL_AFTER_MS = 60_000;

export type IdleCapAction = 'none' | 'stop' | 'kill';

export function idleCapReached(now: number, lastRequestAt: number, running: boolean): boolean {
  return running && now - lastRequestAt >= IDLE_CAP_MS;
}

/** What the alarm should do. `stopSentAt`: when the cap last sent SIGTERM, null if it has not since the
 *  last request. */
export function idleCapAction(now: number, lastRequestAt: number, running: boolean, stopSentAt: number | null): IdleCapAction {
  if (!idleCapReached(now, lastRequestAt, running)) return 'none';
  if (stopSentAt !== null && stopSentAt >= lastRequestAt && now - stopSentAt >= KILL_AFTER_MS) return 'kill';
  return stopSentAt !== null && stopSentAt >= lastRequestAt ? 'none' : 'stop';
}
