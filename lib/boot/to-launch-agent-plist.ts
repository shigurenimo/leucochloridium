type Props = {
  label: string
  bunPath: string
  binPath: string
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
  envVars: Record<string, string>
  keepAwake: boolean
}

/**
 * Build the macOS LaunchAgent plist text for the leuco daemon. The agent runs
 * `bun <binPath> run` in the foreground; launchd is the supervisor, so
 * `KeepAlive` is true and `RunAtLoad` triggers a launch on login. Values are
 * XML-escaped so paths or env values containing `&`/`<` don't break the plist.
 *
 * When `keepAwake` is true, the program is wrapped with `caffeinate -is` so
 * the system stays awake while leuco runs. `-s` extends suppression to
 * system/clamshell sleep on AC power (it is a no-op on battery).
 */
export const toLaunchAgentPlist = (props: Props): string => {
  const envEntries = Object.entries(props.envVars)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n")

  const envBlock =
    envEntries.length === 0
      ? ""
      : `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>`

  const programLines: string[] = []
  if (props.keepAwake) {
    programLines.push(`    <string>/usr/bin/caffeinate</string>`)
    programLines.push(`    <string>-is</string>`)
  }
  programLines.push(`    <string>${escapeXml(props.bunPath)}</string>`)
  programLines.push(`    <string>${escapeXml(props.binPath)}</string>`)
  programLines.push(`    <string>run</string>`)
  const programBlock = programLines.join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(props.label)}</string>

  <key>ProgramArguments</key>
  <array>
${programBlock}
  </array>${envBlock}

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${escapeXml(props.workingDirectory)}</string>

  <key>StandardOutPath</key>
  <string>${escapeXml(props.stdoutPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(props.stderrPath)}</string>
</dict>
</plist>
`
}

const escapeXml = (value: string): string => {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
