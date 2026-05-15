import { EventEmitter } from 'node:events'

export type ChunkCoord = { x: number; z: number; dim: string }

export type GuiEvent =
  | { type: 'chunk';   x: number; z: number; dim: string }
  | { type: 'chunks';  list: ChunkCoord[] }
  | { type: 'unload';  x: number; z: number; dim: string }
  | { type: 'dim';     dim: string }
  | { type: 'log';     level: 'info' | 'warn' | 'err' | 'dbg'; msg: string; ts: number }
  | { type: 'session'; state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'; detail?: string }
  | { type: 'status';  running: boolean; target?: string; chunksByDim?: Record<string, number>; dim?: string; entities?: number; containers?: number }
  | { type: 'flush';   total: number; ok: number }

/** Singleton event bus connecting capture/log -> GUI server. */
export const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emit(ev: GuiEvent) {
  bus.emit('event', ev)
}

/**
 * High-frequency chunk events get coalesced into batches and flushed at most
 * once every CHUNK_BATCH_MS. At 100+ chunks/sec the GUI was lagging from
 * per-chunk WebSocket messages and per-chunk canvas draws — batching cuts
 * that by 10-20x without losing any data.
 */
const CHUNK_BATCH_MS = 60
let chunkBuffer: ChunkCoord[] = []
let chunkFlushTimer: NodeJS.Timeout | null = null

export function emitChunk(coord: ChunkCoord) {
  chunkBuffer.push(coord)
  if (!chunkFlushTimer) {
    chunkFlushTimer = setTimeout(flushChunkBuffer, CHUNK_BATCH_MS)
  }
}

function flushChunkBuffer() {
  chunkFlushTimer = null
  if (chunkBuffer.length === 0) return
  const list = chunkBuffer
  chunkBuffer = []
  bus.emit('event', { type: 'chunks', list } as GuiEvent)
}
