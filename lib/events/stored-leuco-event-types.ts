const STORED_TYPE_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "runtime.started": ["runtime.started", "tenant.started"],
  "runtime.stopped": ["runtime.stopped", "tenant.stopped"],
  "supervisor.reconcile": ["supervisor.reconcile", "engine.reconcile"],
  "supervisor.reconcile.failed": ["supervisor.reconcile.failed", "engine.reconcile.failed"],
}

export function storedLeucoEventTypes(type: string): ReadonlyArray<string> {
  return STORED_TYPE_ALIASES[type] ?? [type]
}
