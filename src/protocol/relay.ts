import type { SealedFrame } from './e2e.js'
import type { ClientFrame, ServerFrame } from './frames.js'

export interface RelayDevice {
  id: string
  name: string
  online: boolean
}

/** Quadros do relay para o daemon, multiplexados por canal. */
export type RelayToDaemon =
  | { t: 'open'; ch: string; client: string }
  | { t: 'frame'; ch: string; frame: ClientFrame | SealedFrame }
  | { t: 'close'; ch: string }
  | { t: 'trigger'; id: string; trigger_id: string; headers: Record<string, string>; body: string }
  | { t: 'ping' }

/** Quadros do daemon para o relay. Pelo relay, os quadros do protocolo viajam cifrados de ponta a ponta. */
export type DaemonToRelay =
  | { t: 'frame'; ch: string; frame: ServerFrame | SealedFrame }
  | { t: 'close'; ch: string }
  | { t: 'trigger_result'; id: string; accepted: boolean; reason?: string }
  | { t: 'pong' }

/** Quadros do cliente para o relay antes de anexar a um dispositivo. */
export type ClientToRelay =
  | { type: 'relay.auth'; account_token: string; client: string }
  | { type: 'relay.devices' }
  | { type: 'relay.attach'; device_id: string }
  | ClientFrame
  | SealedFrame

/** Quadros do relay para o cliente. */
export type RelayToClient =
  | { type: 'relay.devices'; devices: RelayDevice[] }
  | { type: 'relay.attached'; device_id: string; device_name: string }
  | { type: 'relay.detached'; reason: string }
  | { type: 'relay.error'; message: string }
  | ServerFrame
  | SealedFrame

export const relayHeaders = {
  accountToken: 'x-agent-hub-account',
  deviceId: 'x-agent-hub-device-id',
  deviceName: 'x-agent-hub-device-name',
} as const
