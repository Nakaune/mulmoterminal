// A memo keyed by a file's (mtime, size), for a value folded out of an append-only input:
// it remembers where the last scan stopped, so a file that GREW costs only the bytes that were
// added. Purpose-built for session transcripts, whose `.jsonl` is append-only and can be hundreds
// of MB — re-reading and re-parsing one on every window focus / grid-cell refresh stalls the event
// loop, and re-reading FIFTY of them is what made the session list take 5 s (#1377).
//
// `size` guards the sub-millisecond case where a file is rewritten within the same mtime
// tick; together (mtime, size) is a cheap, good-enough freshness stamp (a full content hash
// would defeat the point — we're avoiding reading the file at all on a hit).

export interface FileStamp {
  mtimeMs: number;
  size: number;
  dev?: number;
  ino?: number;
}

/** What a partially-folded, append-only file left behind: everything folded so far, and the byte
 *  the next scan resumes at. */
export interface AppendScan<T> {
  from: number;
  value: T;
}

/** An unchanged file is not the only cheap case: a file that merely GREW can be caught up by folding
 *  the new bytes, instead of being read from the start (#1377 — the session list was re-reading
 *  gigabytes it had read).
 *
 *  Nothing is resumable when the file got SHORTER (truncated, or replaced by a shorter one), nor
 *  when it stayed the same length but was written again — a same-size rewrite is the case mtime
 *  catches here, mirroring how size catches a same-mtime rewrite. A file rewritten wholesale into
 *  something LONGER still reads as an append; that is the (mtime, size) approximation this stamp
 *  is, and a transcript is only ever appended to. */
export interface AppendFileCache<T> {
  resume(key: string, stamp: FileStamp): AppendScan<T> | undefined;
  set(key: string, stamp: FileStamp, from: number, value: T): void;
}

export function createAppendFileCache<T>(max = 500): AppendFileCache<T> {
  const entries = createLruStore<{ stamp: FileStamp; scan: AppendScan<T> }>(max);
  return {
    resume(key, stamp) {
      const hit = entries.get(key);
      if (!hit || stamp.size < Math.max(hit.stamp.size, hit.scan.from) || stamp.dev !== hit.stamp.dev || stamp.ino !== hit.stamp.ino) return undefined;
      if (stamp.size === hit.stamp.size && stamp.mtimeMs !== hit.stamp.mtimeMs) return undefined;
      return hit.scan;
    },
    set(key, stamp, from, value) {
      entries.set(key, { stamp, scan: { from, value } });
    },
  };
}

// The bookkeeping both caches share: insertion-ordered Map, re-inserted on every hit so the
// oldest untouched key is the one evicted.
function createLruStore<V>(max: number) {
  const entries = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key); // move to end (most-recently used)
      entries.set(key, hit);
      return hit;
    },
    set(key: string, value: V): void {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}
