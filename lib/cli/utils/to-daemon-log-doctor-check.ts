import type { DoctorCheck } from "@/cli/utils/doctor-check"

export const toDaemonLogDoctorCheck = (logAgeSeconds: number | null): DoctorCheck => {
  if (logAgeSeconds === null) return { status: "warn", message: "log file missing" }
  if (logAgeSeconds < 600) {
    return { status: "ok", message: `log active (${Math.round(logAgeSeconds)}s ago)` }
  }

  return {
    status: "warn",
    message: `log stale (${Math.round(logAgeSeconds)}s since last write)`,
  }
}
