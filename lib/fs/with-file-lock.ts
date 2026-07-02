import { mkdirSync, rmdirSync, statSync } from "node:fs"
import { dirname } from "node:path"

type Props = {
  /** Lock directory path (created with mkdir, removed on release). */
  lockPath: string
  /** How long to wait for a busy lock before throwing. */
  timeoutMs?: number
  /** A lock older than this is considered abandoned and is stolen. */
  staleMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_MS = 10_000
const RETRY_INTERVAL_MS = 10

/**
 * Serialize read-modify-write cycles on a shared file across processes.
 * `mkdir` is atomic on every platform/filesystem we care about, so the lock
 * is a directory: whoever creates it holds it. Both the CLI process and the
 * daemon mutate `~/.leuco/settings.json`, and `atomicWriteJson` alone only
 * prevents torn files — without this lock, concurrent load→transform→save
 * cycles silently drop the loser's update (lost tokens, rolled-back state).
 */
export const withFileLock = <T>(props: Props, fn: () => T): T => {
  acquireLock(props)

  try {
    return fn()
  } finally {
    releaseLock(props.lockPath)
  }
}

const acquireLock = (props: Props): void => {
  const timeoutMs = props.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = props.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeoutMs

  mkdirSync(dirname(props.lockPath), { recursive: true })

  while (true) {
    if (tryAcquire(props.lockPath)) return

    stealIfStale(props.lockPath, staleMs)

    if (Date.now() >= deadline) {
      throw new Error(`file lock busy: ${props.lockPath}`)
    }

    sleepSync(RETRY_INTERVAL_MS)
  }
}

/** Blocking sleep that works on both Bun and Node (tests run under Node). */
const sleepSync = (ms: number): void => {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, ms)
}

const tryAcquire = (lockPath: string): boolean => {
  try {
    mkdirSync(lockPath)
    return true
  } catch {
    return false
  }
}

const stealIfStale = (lockPath: string, staleMs: number): void => {
  try {
    const stat = statSync(lockPath)
    if (Date.now() - stat.mtimeMs > staleMs) releaseLock(lockPath)
  } catch {
    // lock vanished between mkdir failure and stat — next tryAcquire wins
  }
}

const releaseLock = (lockPath: string): void => {
  try {
    rmdirSync(lockPath)
  } catch {
    // already released (stolen as stale) — nothing to do
  }
}
