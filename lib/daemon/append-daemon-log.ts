import { openDaemonLog } from "@/daemon/open-daemon-log"
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { formatLogLine } from "@/format-log-line"

export function appendDaemonLog(home: string, line: string): void {
  const descriptor = openDaemonLog(home, { canRead: true })
  withSyncCleanup(
    () => {
      const discardedBytes =
        fstatSync(descriptor).size >= 4 * 1024 * 1024
          ? rotateDaemonLog(join(home, "daemon.log"), descriptor)
          : 0
      const timestamp = new Date().toISOString()
      const notice =
        discardedBytes === 0
          ? ""
          : `${timestamp} ${formatLogLine(`[warn] Daemon log rotation discarded ${discardedBytes} bytes: no disk space for a retained copy`)}\n`
      appendFileSync(descriptor, `${notice}${timestamp} ${formatLogLine(line)}\n`)
    },
    () => closeSync(descriptor),
  )
}

/**
 * Copy, then truncate in place: daemon stdout/stderr keep the descriptor opened at spawn, so a
 * rename would send later crash output to a retained generation or, eventually, a deleted file.
 * A full disk must not stop the text log: older generations are dropped to make room for the
 * copy, and only when none is left is the live log truncated without one (returns those bytes).
 */
function rotateDaemonLog(path: string, descriptor: number): number {
  // Success drops the oldest generation anyway; removing it first leaves room for the copy.
  rmSync(`${path}.3`, { force: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  for (const older of [`${path}.2`, `${path}.1`, null]) {
    if (copyToTemporary(descriptor, temporaryPath)) {
      withSyncCleanup(
        () => {
          for (const index of [2, 1])
            if (existsSync(`${path}.${index}`))
              renameSync(`${path}.${index}`, `${path}.${index + 1}`)
          renameSync(temporaryPath, `${path}.1`)
        },
        () => rmSync(temporaryPath, { force: true }),
      )
      ftruncateSync(descriptor, 0)
      return 0
    }
    if (older !== null) rmSync(older, { force: true })
  }
  const discardedBytes = fstatSync(descriptor).size
  ftruncateSync(descriptor, 0)
  return discardedBytes
}

/** Returns false when the disk has no room for the copy; other failures still throw. */
function copyToTemporary(source: number, temporaryPath: string): boolean {
  const temporary = { created: false, complete: false }
  try {
    withSyncCleanup(
      () => {
        const copy = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
        temporary.created = true
        withSyncCleanup(
          () => {
            fchmodSync(copy, 0o600)
            copyDescriptor(source, copy)
            fsyncSync(copy)
          },
          () => closeSync(copy),
        )
        temporary.complete = true
      },
      () => {
        if (temporary.created && !temporary.complete) rmSync(temporaryPath, { force: true })
      },
    )
    return true
  } catch (error) {
    if (isOutOfSpace(error)) return false
    throw error
  }
}

function isOutOfSpace(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EDQUOT")
  )
}

function copyDescriptor(source: number, target: number): void {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const copied = { bytes: 0 }
  while (true) {
    const length = readSync(source, buffer, 0, buffer.length, copied.bytes)
    if (length === 0) return
    writeFileSync(target, buffer.subarray(0, length))
    copied.bytes += length
  }
}
