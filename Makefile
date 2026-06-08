BUN ?= bun
ENTRY := lib/index.ts

.PHONY: help dev run start stop status tui check test bun-test typecheck

help:
	@echo "leuco dev targets"
	@echo "  make dev       # smart entry: TUI if daemon up, else spawn daemon"
	@echo "  make run       # foreground daemon (debug, logs to stdout)"
	@echo "  make start     # background daemon"
	@echo "  make stop      # stop daemon"
	@echo "  make status    # daemon status"
	@echo "  make tui       # open TUI (daemon must be running)"
	@echo "  make check     # vp check"
	@echo "  make test      # vp test run + bun-only test files"
	@echo "  make bun-test  # bun test (covers *.bun-test.ts, e.g. bun:sqlite)"
	@echo "  make typecheck # tsc -b"

dev:
	$(BUN) run $(ENTRY)

run:
	$(BUN) run $(ENTRY) run

start:
	$(BUN) run $(ENTRY) start

stop:
	$(BUN) run $(ENTRY) stop

status:
	$(BUN) run $(ENTRY) status

tui:
	$(BUN) run $(ENTRY) tui

check:
	vp check

test:
	vp test run
	$(MAKE) bun-test

bun-test:
	$(BUN) test ./lib/events/leuco-event-bus.bun-test.ts ./lib/logger/leuco-logger-sqlite-sink.bun-test.ts

typecheck:
	bunx tsc -b
