import type { HookConfig } from './runner.js'

export interface CatalogHook {
  id: string
  title: string
  detail: string
  hook: HookConfig
}

/**
 * Ganchos prontos, para ligar sem escrever JSON na mao. Todos usam comando que ja existe na maquina
 * e nenhum deles bloqueia o run: o que falha so avisa.
 */
export const hookCatalog: CatalogHook[] = [
  {
    id: 'formatar-apos-escrita',
    title: 'Formatar o arquivo depois de escrever',
    detail: 'Roda prettier no arquivo que o agente acabou de gravar, quando o projeto tem prettier.',
    hook: {
      event: 'tool.after',
      command: 'npx --no-install prettier --write "$AGENT_HUB_TOOL_PATH" 2>/dev/null || true',
      match: { tool: 'write_file' },
      timeout_ms: 20000,
      format: 'agent-hub',
    },
  },
  {
    id: 'lint-apos-edicao',
    title: 'Conferir lint depois de editar',
    detail: 'Roda eslint so no arquivo editado e devolve o resultado para o agente ver.',
    hook: {
      event: 'tool.after',
      command: 'npx --no-install eslint "$AGENT_HUB_TOOL_PATH" 2>&1 | tail -20 || true',
      match: { tool: 'edit_file' },
      timeout_ms: 30000,
      format: 'agent-hub',
    },
  },
  {
    id: 'bloquear-comando-perigoso',
    title: 'Barrar comando destrutivo',
    detail: 'Recusa run_command com rm -rf, mkfs, dd ou git push --force antes de executar.',
    hook: {
      event: 'tool.before',
      command:
        'case "$AGENT_HUB_TOOL_ARGS" in *"rm -rf"*|*mkfs*|*"dd if="*|*"push --force"*) echo "comando destrutivo barrado pelo gancho"; exit 1;; esac; exit 0',
      match: { tool: 'run_command' },
      timeout_ms: 5000,
      format: 'agent-hub',
    },
  },
  {
    id: 'avisar-fim-de-run',
    title: 'Avisar no terminal quando o run terminar',
    detail: 'Escreve uma linha em ~/.agent-hub/runs.log com agente, parada e custo.',
    hook: {
      event: 'run.end',
      command: 'echo "$(date -Is) $AGENT_HUB_AGENT $AGENT_HUB_STOP $AGENT_HUB_COST_USD" >> "$HOME/.agent-hub/runs.log"',
      match: {},
      timeout_ms: 5000,
      format: 'agent-hub',
    },
  },
  {
    id: 'parar-no-estouro-de-orcamento',
    title: 'Registrar estouro de orcamento',
    detail: 'Guarda em ~/.agent-hub/orcamento.log todo run que bateu no teto, para voce revisar depois.',
    hook: {
      event: 'budget.exceeded',
      command: 'echo "$(date -Is) $AGENT_HUB_AGENT $AGENT_HUB_MESSAGE" >> "$HOME/.agent-hub/orcamento.log"',
      match: {},
      timeout_ms: 5000,
      format: 'agent-hub',
    },
  },
]
