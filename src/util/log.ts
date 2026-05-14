import { emit } from '../gui/bus'

const ts = () => new Date().toISOString().slice(11, 23)

function format(args: unknown[]): string {
  return args
    .map(a => {
      if (a instanceof Error) return a.message
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    })
    .join(' ')
}

function fire(level: 'info' | 'warn' | 'err' | 'dbg', args: unknown[]) {
  emit({ type: 'log', level, msg: format(args), ts: Date.now() })
}

export const log = {
  info: (...a: unknown[]) => { console.log(`[${ts()}]`, ...a);            fire('info', a) },
  warn: (...a: unknown[]) => { console.warn(`[${ts()}] WARN`, ...a);       fire('warn', a) },
  err:  (...a: unknown[]) => { console.error(`[${ts()}] ERR `, ...a);      fire('err',  a) },
  dbg:  (...a: unknown[]) => {
    if (process.env.DEBUG) console.log(`[${ts()}] DBG `, ...a)
    fire('dbg', a)
  },
}
