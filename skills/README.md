# Leuco skills

Agent skills packaged for the [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI. Each subdirectory contains a `SKILL.md` with YAML frontmatter (`name`, `description`) and the prose body.

## Install

```
npx skills add shigurenimo/leuco                # all skills in this repo
npx skills add shigurenimo/leuco -s leuco-cli   # a specific skill
```

The CLI copies the skill into the right place for whichever agent it detects (`.claude/skills/`, `.codex/skills/`, …). See `npx skills --help` for the full surface.

## Skills here

- [`leuco-cli`](./leuco-cli/SKILL.md) — primer for Codex and Claude operating in or against a leuco-managed environment. Covers what leuco is, the CLI shape (use `--help` for details), and the `~/.leuco` filesystem layout.
