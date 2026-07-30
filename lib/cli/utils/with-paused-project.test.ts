import { describe, expect, it, vi } from "vitest"
import { withPausedProject } from "@/cli/utils/with-paused-project"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

describe("withPausedProject", () => {
  it("pauses, mutates, and resumes a running project", async () => {
    const calls: string[] = []
    const outcome = await withPausedProject({
      projectId: PROJECT_ID,
      isDaemonRunning: true,
      control: {
        pauseProject: async () => {
          calls.push("pause")
          return true
        },
        resumeProject: async () => {
          calls.push("resume")
          return true
        },
      },
      operation: () => {
        calls.push("operation")
        return "done"
      },
    })

    expect(calls).toEqual(["pause", "operation", "resume"])
    expect(outcome).toEqual({ wasPaused: true, value: "done" })
  })

  it("resumes after a failed mutation", async () => {
    const resumeProject = vi.fn(async () => true)

    await expect(
      withPausedProject({
        projectId: PROJECT_ID,
        isDaemonRunning: true,
        control: {
          pauseProject: async () => true,
          resumeProject,
        },
        operation: () => {
          throw new Error("mutation failed")
        },
      }),
    ).rejects.toThrow("mutation failed")
    expect(resumeProject).toHaveBeenCalledTimes(1)
  })

  it("runs directly while the daemon is stopped", async () => {
    const pauseProject = vi.fn(async () => true)
    const resumeProject = vi.fn(async () => true)
    const outcome = await withPausedProject({
      projectId: PROJECT_ID,
      isDaemonRunning: false,
      control: { pauseProject, resumeProject },
      operation: () => 42,
    })

    expect(outcome).toEqual({ wasPaused: false, value: 42 })
    expect(pauseProject).not.toHaveBeenCalled()
    expect(resumeProject).not.toHaveBeenCalled()
  })
})
