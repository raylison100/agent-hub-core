import WebSocket from 'ws'
import { deriveE2eKey, isSealed, open, seal } from './e2e.js'
import type { ClientFrame, ServerFrame } from './frames.js'
import type { ClientToRelay, RelayToClient } from './relay.js'

export interface NodeClientOptions {
  url: string
  token: string
  accountToken?: string
  deviceId?: string
  client: string
  log?: (message: string) => void
}

const protocolVersion = 1
const backoffMs = [2000, 5000, 10000, 30000]

/** Cliente Node do protocolo do daemon, direto ou pelo relay com cifra ponta a ponta, com reconexao. */
export class NodeDaemonClient {
  private socket: WebSocket | null = null
  private listeners = new Set<(f: ServerFrame) => void>()
  private waiters: { type: ServerFrame['type']; resolve: (f: ServerFrame) => void; reject: (e: Error) => void }[] = []
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []
  private attempts = 0
  private stopped = false
  private key: CryptoKey | null = null
  private attached = false
  online = false

  constructor(private readonly opts: NodeClientOptions) {}

  on(fn: (f: ServerFrame) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.socket?.close()
  }

  /** Resolve quando a autenticacao concluir, ou rejeita no prazo. */
  ready(timeoutMs = 10000): Promise<void> {
    if (this.online) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.resolve !== resolve)
        reject(new Error('daemon não respondeu a tempo'))
      }, timeoutMs)
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  send(frame: ClientFrame): void {
    if (!this.online || !this.socket) throw new Error('daemon desconectado')
    void this.raw(frame)
  }

  request<T extends ServerFrame['type']>(frame: ClientFrame, type: T, timeoutMs = 15000): Promise<Extract<ServerFrame, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new Error(`sem resposta para ${frame.type}`))
      }, timeoutMs)
      const waiter = {
        type,
        resolve: (f: ServerFrame) => {
          clearTimeout(timer)
          resolve(f as Extract<ServerFrame, { type: T }>)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      this.waiters.push(waiter)
      try {
        this.send(frame)
      } catch (err) {
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(err as Error)
      }
    })
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  private async connect(): Promise<void> {
    if (this.opts.accountToken && !this.key) this.key = await deriveE2eKey(this.opts.accountToken)
    const url = new URL(this.opts.url)
    if (this.opts.accountToken && !url.pathname.endsWith('/client')) url.pathname = url.pathname.replace(/\/$/, '') + '/client'
    const socket = new WebSocket(url)
    this.socket = socket
    this.attached = false
    socket.on('open', () => {
      if (this.opts.accountToken) this.plain({ type: 'relay.auth', account_token: this.opts.accountToken, client: this.opts.client })
      else this.plain({ type: 'auth', token: this.opts.token, protocol_version: protocolVersion, client: this.opts.client })
    })
    socket.on('message', (raw) => void this.receive(JSON.parse(String(raw)) as RelayToClient))
    socket.on('error', (err) => this.log(`conexão: ${err.message}`))
    socket.on('close', () => {
      this.online = false
      for (const w of this.waiters.splice(0)) w.reject(new Error('conexão encerrada'))
      if (this.stopped) {
        for (const w of this.readyWaiters.splice(0)) w.reject(new Error('conexão encerrada'))
        return
      }
      const delay = backoffMs[Math.min(this.attempts, backoffMs.length - 1)]!
      this.attempts += 1
      setTimeout(() => void this.connect(), delay)
    })
  }

  private async receive(incoming: RelayToClient): Promise<void> {
    const frame = isSealed(incoming) && this.key ? await open<ServerFrame>(this.key, incoming) : (incoming as Exclude<RelayToClient, { e: 1 }>)
    switch (frame.type) {
      case 'relay.devices': {
        const wanted = this.opts.deviceId ?? frame.devices[0]?.id
        if (wanted) this.plain({ type: 'relay.attach', device_id: wanted })
        else this.log('relay sem dispositivos online')
        return
      }
      case 'relay.attached':
        this.attached = true
        await this.raw({ type: 'auth', token: this.opts.token, protocol_version: protocolVersion, client: this.opts.client })
        return
      case 'relay.detached':
        this.log(`relay: ${frame.reason}`)
        this.socket?.close()
        return
      case 'relay.error':
        this.log(`relay: ${frame.message}`)
        return
      case 'auth.ok':
        this.online = true
        this.attempts = 0
        this.log(`conectado ao dispositivo ${frame.device}`)
        for (const w of this.readyWaiters.splice(0)) w.resolve()
        for (const l of this.listeners) l(frame)
        return
      case 'auth.error':
        this.log(`auth: ${frame.message}`)
        this.stopped = true
        for (const w of this.readyWaiters.splice(0)) w.reject(new Error(frame.message))
        this.socket?.close()
        return
      default:
        this.dispatch(frame)
    }
  }

  private dispatch(frame: ServerFrame): void {
    if (frame.type === 'error') {
      const w = this.waiters.shift()
      if (w) w.reject(new Error(frame.message))
    } else {
      const i = this.waiters.findIndex((w) => w.type === frame.type)
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(frame)
    }
    for (const l of this.listeners) l(frame)
  }

  private async raw(frame: ClientFrame): Promise<void> {
    if (this.key && this.attached) this.plain(await seal(this.key, frame))
    else this.plain(frame)
  }

  private plain(frame: ClientToRelay): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
  }
}
