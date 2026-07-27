export const parseLegacyDaemonPid = (text: string): number | null => {
  if (!/^[1-9]\d*$/.test(text)) return null

  const pid = Number(text)
  return Number.isSafeInteger(pid) ? pid : null
}
