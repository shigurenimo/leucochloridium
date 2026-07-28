# Security policy

Please report suspected vulnerabilities privately through GitHub's security-advisory
form for this repository. Do not include tokens, message bodies, local paths, or other
secrets in a public issue.

Security fixes are made on the latest release line. Reports should include the affected
Leuco version, a minimal reproduction, expected impact, and whether the issue requires
local access, Slack access, or control of a configured project.

Leuco stores Slack tokens and message-bearing event data locally. Keep
`~/.leuco/settings.json`, `~/.leuco/daemon/events.db`, and project Codex homes restricted
to their owner, and rotate any credential that may have been exposed.
