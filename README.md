# agent-hub-core

Biblioteca TypeScript que concentra a logica do Agent Hub: fala com os
provedores de modelo, roda o laco do agente, conta custo, escolhe o agente,
monta o contexto, valida e executa ferramentas e define o protocolo entre o
daemon e os clientes. Nao abre porta nem guarda estado sozinha: quem usa e o
[daemon](https://github.com/raylison100/agent-hub-daemon).

## Comandos

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Requer Node 22 ou superior.

## O que tem aqui

```
src/
  types.ts                 Message, Part, ToolDefinition, Usage, ChatRequest, ProviderAdapter
  providers/
    anthropic.ts           SDK oficial, streaming, cache_control, raciocinio adaptativo
    openai-compatible.ts   DeepSeek, Gemini e Ollama; formato JSON forcado no Ollama
    openai-responses.ts    Responses API da OpenAI
    cap.ts                 teto de saida somando o orcamento de raciocinio
    index.ts               createAdapter(perfil)
  loop/runner.ts           AgentRunner: orcamento, ledger, aprovacao, reparo, fases, compactacao, delegacao
  cost/                    pricing (com desconto por horario), ledger no SQLite, budgets por escopo
  agents/
    schema.ts, load.ts     perfis, papeis, skills, politicas, MCP, agendamentos e gatilhos validados com Zod
    routing.ts             intencoes, regras, classificador e melhorador de prompt
    scoring.ts             pontuacao capacidade contra custo e contexto, com exclusoes
    workspace-context.ts   instrucoes, glossario e memoria do projeto dentro de um teto de tokens
    verify.ts              verificacao por codigo do resultado de um run e esquema da cascata
    workflows.ts           etapas fixas, portao de confianca e custo maximo
    resume.ts              ponto de retomada da sessao
    plugins.ts             plugins no layout do Claude Code
  context/                 estimativa de tokens, poda e resumo do historico
  tools/
    native.ts              list_dir, read_file, search, write_file, edit_file, run_command, git
    select.ts              ferramentas de MCP escolhidas por relevancia e fixas por sessao
    policy.ts, validate.ts politica allow, ask, deny e validacao com JSON Schema
    mcp.ts, oauth.ts       cliente MCP stdio e HTTP, OAuth 2.1 com PKCE
    context-files.ts       memory_read, memory_write e spec_write
    redact.ts              redacao de segredos na saida
  knowledge/               base de conhecimento em FTS5 com citacao por linha
  hooks/                   ganchos de ciclo de vida e catalogo pronto
  protocol/                quadros WebSocket, relay, cifra ponta a ponta e cliente Node
```

## Principios que o codigo segue

- O adaptador nunca estima uso. Le o campo da resposta ou marca `missing`.
- Nenhuma chamada ao modelo sem passar pelo orcamento e pelo ledger.
- O comeco do prompt nao muda entre mensagens da mesma sessao, para o cache do
  provedor e do Ollama valer: ferramentas fixas por sessao e memoria entregue na
  mensagem que a ativou.
- O modelo propoe, o harness dispoe: roteamento, validacao, politica, fases,
  custo e verificacao sao decididos por codigo.
- Chamada de ferramenta invalida volta ao modelo como erro ate `repair_attempts`;
  depois o run para com `tool_call_invalid` e o daemon escala para `fallback_agent`.

## Testes

`test/` cobre uso por provedor com fixtures, precos, orcamentos, perfis,
roteamento e pontuacao, selecao de ferramentas, contexto do projeto,
verificacao, workflows, OAuth e o runner com adaptador falso.

## Parte do Agent Hub

Este repositorio e uma das partes do [Agent Hub](https://github.com/raylison100/agent-hub),
um gerenciador de modelos de IA que roda na sua maquina. A documentacao geral
esta na [wiki](https://github.com/raylison100/agent-hub/wiki).

| Repositorio | Papel |
|---|---|
| [agent-hub](https://github.com/raylison100/agent-hub) | ponto de partida, Makefile, scripts e wiki |
| [agent-hub-core](https://github.com/raylison100/agent-hub-core) | biblioteca TypeScript: adaptadores, laco do agente, custo, roteamento, ferramentas, protocolo |
| [agent-hub-daemon](https://github.com/raylison100/agent-hub-daemon) | servico local: sessoes, runs, aprovacoes, automacao, conectores, API WebSocket |
| [agent-hub-web](https://github.com/raylison100/agent-hub-web) | interface Vue 3 como PWA, a mesma no navegador, no celular e no desktop |
| [agent-hub-agents](https://github.com/raylison100/agent-hub-agents) | perfis, papeis, skills, workflows, precos, roteamento e politicas, em texto |
| [agent-hub-desktop](https://github.com/raylison100/agent-hub-desktop) | app Tauri 2 para Windows e Linux |
| [agent-hub-relay](https://github.com/raylison100/agent-hub-relay) | retransmissor sem estado para acesso remoto |
| [agent-hub-channels](https://github.com/raylison100/agent-hub-channels) | clientes em plataformas de mensagem, hoje Telegram |
| [agent-hub-docs](https://github.com/raylison100/agent-hub-docs) | planejamento, arquitetura, ADRs e a fonte das paginas da wiki |

## Licenca

[PolyForm Noncommercial 1.0.0](LICENSE). Pode ler, estudar, modificar e usar
para fins pessoais, de pesquisa, ensino ou em organizacao sem fins lucrativos.
Uso comercial nao e permitido sem autorizacao do autor.

Required Notice: Copyright (c) 2026 Raylison Nunes (https://github.com/raylison100)
