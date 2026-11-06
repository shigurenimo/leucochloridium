import { beforeEach, expect, it, vi } from "vitest"
import { appendDaemonLog } from "@/daemon/append-daemon-log"

type Inode = { bytes: Buffer; mode: number }
type Disk = {
  files: Map<string, Inode>
  descriptors: Map<number, Inode>
  nextDescriptor: number
  capacity: number
  temporaryOpenFailure: Error | null
}
const disk = vi.hoisted((): Disk => ({
  files: new Map(),
  descriptors: new Map(),
  nextDescriptor: 10,
  capacity: Number.POSITIVE_INFINITY,
  temporaryOpenFailure: null,
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const fault = (code: string) => Object.assign(new Error(`${code}: memory disk`), { code })
  const usedBytes = () =>
    [...new Set([...disk.files.values(), ...disk.descriptors.values()])].reduce(
      (total, inode) => total + inode.bytes.length,
      0,
    )
  const opened = (descriptor: number): Inode => {
    const inode = disk.descriptors.get(descriptor)
    if (inode === undefined) throw fault("EBADF")
    return inode
  }
  const write = (descriptor: number, written: string | Uint8Array): void => {
    const inode = opened(descriptor)
    const bytes = Buffer.from(written)
    if (usedBytes() + bytes.length > disk.capacity) throw fault("ENOSPC")
    inode.bytes = Buffer.concat([inode.bytes, bytes])
  }
  return {
    constants: actual.constants,
    openSync: (path: string, flags: number, mode: number) => {
      if (path.endsWith(".tmp") && disk.temporaryOpenFailure !== null)
        throw disk.temporaryOpenFailure
      const existing = disk.files.get(path)
      if (existing !== undefined && (flags & actual.constants.O_EXCL) !== 0) throw fault("EEXIST")
      const inode = existing ?? { bytes: Buffer.alloc(0), mode }
      disk.files.set(path, inode)
      disk.nextDescriptor += 1
      disk.descriptors.set(disk.nextDescriptor, inode)
      return disk.nextDescriptor
    },
    fstatSync: (descriptor: number) => ({
      size: opened(descriptor).bytes.length,
      isFile: () => true,
    }),
    fchmodSync: (descriptor: number, mode: number) => {
      opened(descriptor).mode = mode
    },
    closeSync: (descriptor: number) => {
      opened(descriptor)
      disk.descriptors.delete(descriptor)
    },
    appendFileSync: write,
    writeFileSync: write,
    fsyncSync: (descriptor: number) => {
      opened(descriptor)
    },
    readSync: (
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytes = opened(descriptor).bytes
      return bytes.copy(buffer, offset, position, Math.min(position + length, bytes.length))
    },
    ftruncateSync: (descriptor: number, length: number) => {
      const inode = opened(descriptor)
      inode.bytes = Buffer.from(inode.bytes.subarray(0, length))
    },
    existsSync: (path: string) => disk.files.has(path),
    renameSync: (from: string, to: string) => {
      const inode = disk.files.get(from)
      if (inode === undefined) throw fault("ENOENT")
      disk.files.set(to, inode)
      disk.files.delete(from)
    },
    rmSync: (path: string) => {
      disk.files.delete(path)
    },
  }
})

const MIB = 1024 * 1024
const live = "/memory/daemon.log"
const generation = (fill: string): Inode => ({ bytes: Buffer.alloc(4 * MIB, fill), mode: 0o600 })
const firstByte = (path: string) => disk.files.get(path)?.bytes.subarray(0, 1).toString()
const temporaryFiles = () => [...disk.files.keys()].filter((path) => path.endsWith(".tmp"))
beforeEach(() => {
  disk.files.clear()
  disk.descriptors.clear()
  disk.capacity = Number.POSITIVE_INFINITY
  disk.temporaryOpenFailure = null
})

it("frees the oldest generation before copying, so a nearly full disk keeps logging", () => {
  const current = generation("c")
  disk.files.set(live, current)
  for (const index of [1, 2, 3]) disk.files.set(`${live}.${index}`, generation(String(index)))
  // The daemon's stdout/stderr descriptor stays bound to the live inode.
  disk.descriptors.set(1, current)
  disk.capacity = 16 * MIB + 2 * MIB
  appendDaemonLog("/memory", "after-full")
  expect(disk.files.get(live)).toBe(current)
  expect(current.bytes.toString()).toMatch(/^\S+ after-full\n$/)
  expect(disk.files.get(`${live}.1`)?.bytes.equals(Buffer.alloc(4 * MIB, "c"))).toBe(true)
  expect(disk.files.get(`${live}.1`)?.mode).toBe(0o600)
  expect([firstByte(`${live}.2`), firstByte(`${live}.3`)]).toEqual(["1", "2"])
  expect(temporaryFiles()).toEqual([])
})

it("drops older generations before discarding the newest log when no copy fits", () => {
  disk.files.set(live, generation("c"))
  disk.files.set(`${live}.1`, generation("1"))
  disk.capacity = 8 * MIB + MIB
  appendDaemonLog("/memory", "after-full")
  expect(disk.files.get(`${live}.1`)?.bytes.equals(Buffer.alloc(4 * MIB, "c"))).toBe(true)
  expect(disk.files.has(`${live}.2`)).toBe(false)
  expect(disk.files.get(live)?.bytes.toString()).toMatch(/^\S+ after-full\n$/)
  expect(temporaryFiles()).toEqual([])
})

it("truncates without a copy and records the loss when nothing can be freed", () => {
  const current = generation("c")
  disk.files.set(live, current)
  disk.capacity = 4 * MIB + MIB
  appendDaemonLog("/memory", "after-full")
  expect(disk.files.get(live)).toBe(current)
  const lines = current.bytes.toString().trimEnd().split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(
    /^\S+ \[warn\] Daemon log rotation discarded 4194304 bytes: no disk space for a retained copy$/,
  )
  expect(lines[1]).toMatch(/^\S+ after-full$/)
  expect(disk.files.has(`${live}.1`)).toBe(false)
  expect(temporaryFiles()).toEqual([])
})

it("keeps other copy failures visible without shifting or truncating generations", () => {
  const current = generation("c")
  disk.files.set(live, current)
  disk.files.set(`${live}.1`, generation("1"))
  disk.temporaryOpenFailure = Object.assign(new Error("permission denied"), { code: "EACCES" })
  expect(() => appendDaemonLog("/memory", "denied")).toThrow("permission denied")
  expect(current.bytes.equals(Buffer.alloc(4 * MIB, "c"))).toBe(true)
  expect(firstByte(`${live}.1`)).toBe("1")
  expect(disk.files.has(`${live}.2`)).toBe(false)
  expect(disk.descriptors.size).toBe(0)
})
