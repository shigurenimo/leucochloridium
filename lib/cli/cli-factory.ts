import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import type { LoadEnvFileResult } from "@/env/leuco-env"
import { HTTPException } from "hono/http-exception"

export type EnvFiles = {
  local: LoadEnvFileResult
  base: LoadEnvFileResult
}

export type CliVariables = {
  daemon: LeucoDaemon
  cwd: string
  projectIdScope: string | null
  binPath: string
  envFiles: EnvFiles
  version: string
}

type CliRequest = {
  path: string
  param(name: string): string
  text(): Promise<string>
}

export type CliContext = {
  readonly req: CliRequest
  readonly var: CliVariables
  set<K extends keyof CliVariables>(key: K, value: CliVariables[K]): void
  text(value: string, status?: number, headers?: Readonly<Record<string, string>>): Response
  json(value: unknown, status?: number): Response
}

export type CliHandler = (context: CliContext) => Response | Promise<Response>
type CliMiddleware = (
  context: CliContext,
  next: () => Promise<Response>,
) => void | Response | Promise<void | Response>
type CliErrorHandler = (error: Error, context: CliContext) => Response | Promise<Response>

type Route = {
  pattern: string
  handlers: ReadonlyArray<CliHandler>
}

type DispatchProps = {
  path: string
  body?: string
  variables?: Partial<CliVariables>
}

const DEFAULT_VARIABLES: CliVariables = {
  daemon: undefined as unknown as LeucoDaemon,
  cwd: "",
  projectIdScope: null,
  binPath: "",
  envFiles: {
    local: { path: "", loaded: false, keys: [] },
    base: { path: "", loaded: false, keys: [] },
  },
  version: "",
}

/** Small command router used only in process; no URL, Request, or fetch layer. */
export class CliRouter {
  private readonly routes: Route[] = []
  private readonly middleware: CliMiddleware[] = []
  private errorHandler: CliErrorHandler = (error, context) =>
    context.text(`error: ${error.message}`, error instanceof HTTPException ? error.status : 500)
  private notFoundHandler: CliHandler = (context) =>
    context.text(`unknown command: ${context.req.path}`, 404)

  use(middleware: CliMiddleware): this {
    this.middleware.push(middleware)
    return this
  }

  onError(handler: CliErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  notFound(handler: CliHandler): this {
    this.notFoundHandler = handler
    return this
  }

  command(pattern: string, ...handlers: ReadonlyArray<CliHandler>): this {
    this.routes.push({ pattern, handlers })
    return this
  }

  async dispatch(props: DispatchProps): Promise<Response> {
    const matched = this.match(props.path)
    const variables = { ...DEFAULT_VARIABLES, ...props.variables }
    const context = createContext({
      path: props.path,
      body: props.body ?? "",
      params: matched?.params ?? {},
      variables,
    })
    const routeHandler =
      matched === null
        ? () => Promise.resolve(this.notFoundHandler(context))
        : () => runHandlers(matched.route.handlers, context)

    try {
      return await runMiddleware(this.middleware, context, routeHandler)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      return await this.errorHandler(normalized, context)
    }
  }

  private match(path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      const params = matchPattern(route.pattern, path)
      if (params !== null) return { route, params }
    }
    return null
  }
}

export const factory = {
  createApp: (): CliRouter => new CliRouter(),
  createHandlers: (...handlers: ReadonlyArray<CliHandler>): ReadonlyArray<CliHandler> => handlers,
}

const createContext = (props: {
  path: string
  body: string
  params: Record<string, string>
  variables: CliVariables
}): CliContext => {
  return {
    req: {
      path: props.path,
      param: (name) => props.params[name] ?? "",
      text: async () => props.body,
    },
    var: props.variables,
    set: (key, value) => {
      props.variables[key] = value
    },
    text: (value, status = 200, headers = {}) =>
      new Response(value, {
        status,
        headers: {
          "content-type": "text/plain; charset=UTF-8",
          ...headers,
        },
      }),
    json: (value, status = 200) =>
      Response.json(value, {
        status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      }),
  }
}

const runHandlers = async (
  handlers: ReadonlyArray<CliHandler>,
  context: CliContext,
): Promise<Response> => {
  const handler = handlers[0]
  if (handler === undefined) return context.text("", 204)
  return await handler(context)
}

const runMiddleware = async (
  middleware: ReadonlyArray<CliMiddleware>,
  context: CliContext,
  route: () => Promise<Response>,
): Promise<Response> => {
  const invoke = async (index: number): Promise<Response> => {
    const current = middleware[index]
    if (current === undefined) return route()
    let nextResponse: Response | null = null
    const result = await current(context, async () => {
      nextResponse = await invoke(index + 1)
      return nextResponse
    })
    if (result instanceof Response) return result
    if (nextResponse !== null) return nextResponse
    return context.text("", 204)
  }
  return invoke(0)
}

const matchPattern = (pattern: string, path: string): Record<string, string> | null => {
  const expected = segments(pattern)
  const actual = segments(path)
  if (expected.length !== actual.length) return null

  const params: Record<string, string> = {}
  for (const entry of expected.entries()) {
    const index = entry[0]
    const expectedSegment = entry[1]!
    const actualSegment = actual[index]!
    if (expectedSegment.startsWith(":")) {
      params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment)
      continue
    }
    if (expectedSegment !== actualSegment) return null
  }
  return params
}

const segments = (path: string): string[] => {
  if (path === "/") return []
  return path.replace(/^\/+|\/+$/g, "").split("/")
}
