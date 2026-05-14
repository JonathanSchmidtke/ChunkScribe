import { EventEmitter } from 'node:events'

export type GuiEvent =
  | { type: 'chunk';   x: number; z: number; dim: string }
  | { type: 'unload';  x: number; z: number; dim: string }
  | { type: 'dim';     dim: string }
  | { type: 'log';     level: 'info' | 'warn' | 'err' | 'dbg'; msg: string; ts: number }
  | { type: 'session'; state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'; detail?: string }
  | { type: 'status';  running: boolean; target?: string; chunksByDim?: Record<string, number>; dim?: string }
  | { type: 'flush';   total: number; ok: number }

/** Singleton event bus connecting capture/log -> GUI server. */
export const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emit(ev: GuiEvent) {
  bus.emit('event', ev)
}
