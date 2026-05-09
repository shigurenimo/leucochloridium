/**
 * Wait between the disable-then-enable SIGHUPs that drive
 * "agent restart" / "channel restart" / "agent reset" CLI flows.
 *
 * The CLI has no observable handshake to know when the daemon's reconcile
 * pass has settled, so we sleep long enough for the previous SIGHUP to
 * propagate through `LeucoEngine.reconcile()` (which now serializes via
 * `reconcileQueue`) and tear the affected tenant down before the next
 * SIGHUP arrives. 400ms was chosen empirically; bump it if reconcile work
 * grows past one tick of cron / Slack reconnect.
 *
 * Long term this should be replaced with a "reload completed" event the
 * CLI subscribes to via the gateway, eliminating the timing guess.
 */
export const RECONCILE_GAP_MS = 400

export const sleepReconcileGap = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, RECONCILE_GAP_MS))
