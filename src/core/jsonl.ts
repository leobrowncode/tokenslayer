import { promises as fsp } from 'node:fs';

export type LineHandler<S> = (state: S, obj: any, file: string, lineOffset: number) => void;

interface Entry<S> {
  offset: number;
  partial: Buffer;
  state: S;
}

/**
 * Incrementally parses append-only JSONL files: each `update` only reads bytes written since the
 * previous call. A file that shrinks is treated as rewritten and re-parsed from scratch.
 */
export class JsonlTailer<S> {
  private entries = new Map<string, Entry<S>>();

  constructor(
    private readonly init: () => S,
    private readonly onLine: LineHandler<S>,
    private readonly chunkSize = 4 * 1024 * 1024,
  ) {}

  get(file: string): S | undefined {
    return this.entries.get(file)?.state;
  }

  entriesList(): Array<[string, S]> {
    return [...this.entries].map(([k, e]) => [k, e.state]);
  }

  async update(file: string, knownSize?: number): Promise<S> {
    const size = knownSize ?? (await fsp.stat(file)).size;
    let e = this.entries.get(file);
    if (!e || size < e.offset) {
      e = { offset: 0, partial: Buffer.alloc(0), state: this.init() };
      this.entries.set(file, e);
    }
    if (size === e.offset) return e.state;

    const fh = await fsp.open(file, 'r');
    try {
      let pos = e.offset;
      while (pos < size) {
        const len = Math.min(this.chunkSize, size - pos);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        const data = e.partial.length ? Buffer.concat([e.partial, chunk]) : chunk;
        const dataStart = pos - e.partial.length;
        let start = 0;
        let nl: number;
        while ((nl = data.indexOf(0x0a, start)) !== -1) {
          this.handle(e.state, data.subarray(start, nl), file, dataStart + start);
          start = nl + 1;
        }
        e.partial = Buffer.from(data.subarray(start));
        pos += bytesRead;
      }
      e.offset = pos;
    } finally {
      await fh.close();
    }
    return e.state;
  }

  /** Drops state for files no longer being tracked. */
  retain(files: Iterable<string>): void {
    const keep = new Set(files);
    for (const k of this.entries.keys()) if (!keep.has(k)) this.entries.delete(k);
  }

  private handle(state: S, line: Buffer, file: string, offset: number): void {
    const text = line.toString('utf8').trim();
    if (!text) return;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    try {
      this.onLine(state, obj, file, offset);
    } catch {
      /* a malformed record must not stop the rest of the file from being read */
    }
  }
}
