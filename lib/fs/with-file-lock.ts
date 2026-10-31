import { randomUUID } from "node:crypto"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { readRegularText } from "@/fs/read-regular-text"
import { linkSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

type Props = {
  lockPath: string
  timeoutMs?: number
  staleMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_MS = 10_000
const RETRY_INTERVAL_MS = 10

type LockOwner = {
  token: string
  pid: number
}

/**
 * Serialize synchronous read-modify-write cycles across CLI and daemon
 * processes. A fully-written sibling claim file is hard-linked into place,
 * which atomically publishes the owner without replacing an existing lock.
 * An abandoned lock can be reclaimed after a conservative age.
 */
export const withFileLock = <T>(props: Props, fn: () => T): T => {
  const owner = acquireLock(props)
  return withSyncCleanup(fn, () => releaseLock(props.lockPath, owner))
}

const acquireLock = (props: Props): LockOwner => {
  const timeoutMs = props.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = props.staleMs ?? DEFAULT_STALE_MS
  const deadline = performance.now() + timeoutMs
  const owner = { token: randomUUID(), pid: process.pid }

  mkdirSync(dirname(props.lockPath), { recursive: true })

  while (true) {
    if (tryAcquire(props.lockPath, owner)) return owner
    stealIfStale(props.lockPath, staleMs)
    if (performance.now() >= deadline) throw new Error(`file lock busy: ${props.lockPath}`)
    sleepSync(RETRY_INTERVAL_MS)
  }
}

const sleepSync = (ms: number): void => {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, ms)
}

const tryAcquire = (lockPath: string, owner: LockOwner): boolean => {
  const claimPath = `${lockPath}.claim-${owner.token}`
  try {
    writeFileSync(claimPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    if (isNodeErrno(error) && error.code === "EEXIST") throw error
    return withSyncCleanup(
      () => {
        throw error
      },
      () => removeFile(claimPath),
    )
  }

  const published = { value: false }
  try {
    return withSyncCleanup(
      () => {
        try {
          linkSync(claimPath, lockPath)
          published.value = true
          return true
        } catch (error) {
          if (isNodeErrno(error) && error.code === "EEXIST") return false
          throw error
        }
      },
      () => removeFile(claimPath),
    )
  } catch (error) {
    if (published.value)
      return withSyncCleanup(
        () => {
          throw error
        },
        () => releaseLock(lockPath, owner),
      )
    throw error
  }
}

const stealIfStale = (lockPath: string, staleMs: number): void => {
  let observed: ReturnType<typeof statSync>
  try {
    observed = statSync(lockPath)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return
    throw error
  }
  if (Date.now() - observed.mtimeMs <= staleMs) return

  let owner: LockOwner | null
  try {
    owner = inspectOwner(lockPath)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return
    throw error
  }

  if (owner !== null) {
    if (pidIsAlive(owner.pid)) return
    releaseLock(lockPath, owner)
    return
  }

  reclaimMalformedLock(lockPath, observed.dev, observed.ino, staleMs)
}

const releaseLock = (lockPath: string, owner: LockOwner): void => {
  try {
    const current = inspectOwner(lockPath)
    if (current === null) throw new Error(`Cannot verify lock ownership for release: ${lockPath}`)
    if (current.token !== owner.token) return
    unlinkSync(lockPath)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return
    throw error
  }
}

const inspectOwner = (lockPath: string): LockOwner | null => {
  let text: string
  try {
    if (statSync(lockPath).isDirectory()) return null
    text = readRegularText(lockPath, 8192)
  } catch (error) {
    if (isNodeErrno(error) && (error.code === "EISDIR" || error.code === "EINVAL")) return null
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  if (!("token" in value) || typeof value.token !== "string") return null
  if (!("pid" in value) || typeof value.pid !== "number") return null
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null
  return { token: value.token, pid: value.pid }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNodeErrno(error) && error.code === "EPERM") return true
    if (isNodeErrno(error) && error.code === "ESRCH") return false
    throw error
  }
}

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error

const removeFile = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return
    throw error
  }
}

const reclaimMalformedLock = (
  lockPath: string,
  observedDevice: number,
  observedInode: number,
  staleMs: number,
): void => {
  let current: ReturnType<typeof statSync>
  try {
    current = statSync(lockPath)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return
    throw error
  }
  if (current.dev !== observedDevice || current.ino !== observedInode) return
  if (Date.now() - current.mtimeMs <= staleMs) return
  rmSync(lockPath, { recursive: true, force: true })
}
