/** Erro de uma chamada ao provedor que ficou sem mandar nenhum dado pelo tempo limite. */
export class ProviderStalledError extends Error {
  constructor(provider: string, ms: number) {
    super(`${provider} ficou ${Math.round(ms / 1000)} s sem responder; chamada cancelada`)
    this.name = 'ProviderStalledError'
  }
}

export interface IdleWatchdog {
  signal: AbortSignal
  touch(): void
  stalled(): boolean
  dispose(): void
}

/** Sinal de cancelamento que dispara quando passam ms sem touch(), ligado ao sinal do run. */
export function idleWatchdog(ms: number, parent?: AbortSignal): IdleWatchdog {
  const controller = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onParent = () => controller.abort(parent?.reason)
  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener('abort', onParent, { once: true })
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, ms)
  }
  touch()
  return {
    signal: controller.signal,
    touch,
    stalled: () => stalled,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParent)
    },
  }
}
