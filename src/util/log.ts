const ts = () => new Date().toISOString().slice(11, 23)

export const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] WARN`, ...a),
  err:  (...a: unknown[]) => console.error(`[${ts()}] ERR `, ...a),
  dbg:  (...a: unknown[]) => { if (process.env.DEBUG) console.log(`[${ts()}] DBG `, ...a) },
}
