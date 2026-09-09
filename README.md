# @agent-hub/core

Biblioteca TypeScript com adaptadores de provedor, loop de agente, ledger de
custo, orcamentos, ferramentas nativas, ponte MCP e carregador de perfis.

Estado: fase 1, esqueleto funcional com testes. Planejamento em `../docs/`.

## Comandos

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## O que existe

```
src/
  types.ts               Message, ToolDefinition, Usage, ProviderAdapter
  providers/
    anthropic.ts         SDK oficial, streaming, cache_control, effort, replay de blocos brutos
    openai-compatible.ts SDK openai para DeepSeek, OpenAI e Ollama; usage com cache do DeepSeek
    index.ts             createAdapter(perfil) e resolveModel
  cost/
    pricing.ts           tabela por milhao de tokens, curinga provider/*, falha em preco nulo
    ledger.ts            uma linha por chamada no SQLite, totais e relatorios
    budget.ts            escopos run, sessao, agente por dia, global por mes; aviso em 80%
  agents/
    schema.ts            Zod do frontmatter, politicas, budgets.json, mcp.json
    load.ts              perfis, skills (SKILL.md), politicas e MCP de um repositorio agents/
  tools/
    registry.ts          registro de ferramentas com definicoes em ordem estavel
    native.ts            list_dir, read_file, search, write_file, edit_file, run_command, git
    workspace.ts         resolucao de caminho que recusa sair do workspace
    validate.ts          funil de validacao com JSON Schema (Ajv)
    policy.ts            allow, ask, deny por risco; padroes destrutivos sempre perguntam
    mcp.ts               cliente MCP stdio, ferramentas com prefixo servidor__
  context/estimate.ts    estimativa incremental de tokens
  loop/runner.ts         AgentRunner: orcamento antes e depois, ledger, aprovacao, reparo
  protocol/frames.ts     quadros WebSocket entre daemon e clientes
```

## Principios que o codigo segue

- O adaptador nunca estima uso. Le o campo da resposta ou marca `missing`.
- Nenhuma chamada ao modelo sem passar por `Budget.check` e `Ledger.record`.
- Ferramentas entram no prompt em ordem alfabetica e o prompt de sistema
  nao muda entre chamadas, para o cache do provedor funcionar.
- Chamada de ferramenta invalida volta ao modelo como erro ate
  `repair_attempts`; depois o run para com `tool_call_invalid` e o daemon
  escala para `fallback_agent`.

## Testes

`test/` cobre mapeamento de uso por provedor com fixtures, precos,
orcamentos, perfis, validacao, politica e o runner com adaptador falso.
