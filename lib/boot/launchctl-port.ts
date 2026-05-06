/**
 * IO port for the macOS `launchctl` binary. Implementations either shell out to
 * the real binary (`LaunchctlBin`) or record calls in memory for tests
 * (`LaunchctlFake`). All methods return `T | Error`; "service not loaded" is
 * `false` from `isLoaded`, not an error.
 */
export type LaunchctlPort = {
  bootstrap(plistPath: string): Promise<void | Error>
  bootout(plistPath: string): Promise<void | Error>
  isLoaded(label: string): Promise<boolean | Error>
}
