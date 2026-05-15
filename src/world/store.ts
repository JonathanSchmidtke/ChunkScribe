/**
 * In-memory column store, keyed by "x,z". One per dimension.
 * Holds prismarine-chunk Column objects until the saver flushes them.
 */
export class WorldStore {
  private columns = new Map<string, any>()

  constructor(public readonly dimension: string) {}

  setColumn(x: number, z: number, chunk: any) {
    this.columns.set(`${x},${z}`, chunk)
  }

  getColumn(x: number, z: number): any | undefined {
    return this.columns.get(`${x},${z}`)
  }

  entries(): IterableIterator<[string, any]> {
    return this.columns.entries()
  }

  size(): number {
    return this.columns.size
  }

  keys(): IterableIterator<string> {
    return this.columns.keys()
  }
}
