import { isProcessAlive } from "@/daemon/daemon-lease"
import { awaitAbortableDelay } from "@/await-abortable-delay"

export async function waitForDaemonExit(
  pid: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  signal?.throwIfAborted()
  while (performance.now() < deadline && isProcessAlive(pid))
    await awaitAbortableDelay(Math.min(100, Math.max(1, deadline - performance.now())), signal)
  if (isProcessAlive(pid)) throw new Error(`Process exit was not observed within ${timeoutMs}ms`)
}
