import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

/** Timers clamp larger delays to 1ms, so an oversized deadline would fire at once. */
export function assertTimerDelay(name: string, milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > MAX_TIMER_DELAY_MS)
    throw new Error(`${name} must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`)
  return milliseconds
}
