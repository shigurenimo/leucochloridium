import { vi } from "vitest"

class MockStatement {
  run() {}
  get() {
    return undefined
  }
  all() {
    return []
  }
}

class MockDatabase {
  run() {}
  prepare() {
    return new MockStatement()
  }
  exec() {}
  close() {}
  transaction(fn: Function) {
    return fn
  }
}

vi.mock("bun:sqlite", () => ({
  Database: MockDatabase,
}))
