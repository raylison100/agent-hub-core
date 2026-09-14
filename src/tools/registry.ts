import type { ToolDefinition } from '../types.js'

export interface SandboxOptions {
  image: string
  network: boolean
  memory?: string
  cpus?: number
}

export interface ToolContext {
  workspace: string
  runId?: string
  sessionId?: string
  agent?: string
  signal?: AbortSignal
  sandbox?: SandboxOptions
  readRoots?: string[]
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>

export interface RegisteredTool {
  definition: ToolDefinition
  handler: ToolHandler
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool)
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const t of tools) this.register(t)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  /** Devolve definicoes em ordem alfabetica, restritas a uma lista quando informada. */
  definitions(names?: string[]): ToolDefinition[] {
    const wanted = names ? new Set(names) : null
    return this.names()
      .filter((n) => !wanted || wanted.has(n))
      .map((n) => this.tools.get(n)!.definition)
  }

  missing(names: string[]): string[] {
    return names.filter((n) => !this.tools.has(n))
  }
}
