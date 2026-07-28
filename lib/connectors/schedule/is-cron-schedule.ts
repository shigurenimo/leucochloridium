export function isCronSchedule(runAt: string): boolean {
  return /\s/.test(runAt.trim())
}
