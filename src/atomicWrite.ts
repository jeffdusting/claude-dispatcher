/**
 * Atomic file writes — write-temp-and-rename pattern.
 *
 * Plain `writeFileSync` truncates, then writes. If the process is killed
 * mid-write (SIGTERM during a Fly redeploy, OOM kill, `launchctl unload`
 * during cutover), the file is left in a partially-written state and the
 * next reader either crashes or wipes the registry. The fix is to write
 * to a sibling temp file, then rename onto the target — `rename(2)` is
 * atomic on POSIX, so a reader sees either the old file or the new file,
 * never a half-written one.
 *
 * D-001 (architecture review 02 §3.2) audited every state-file writer in
 * the dispatcher under Phase A.4. Writers that previously called
 * `writeFileSync(target, …)` directly now go through `writeJsonAtomic`.
 *
 * The helper is sync deliberately — most callers are tight, in-memory
 * registry persists where the latency is dominated by JSON.stringify and
 * the rename is cheap. The async variant can be added later if a caller
 * needs it.
 */

import { writeFileSync, renameSync } from 'fs'

/**
 * Write `content` to `path` atomically.
 *
 * Implementation: write to a temp sibling `<path>.tmp-<pid>-<ts>`, then
 * rename onto `path`. Includes pid + timestamp so concurrent writers
 * (multiple processes, retries) do not collide on the temp filename.
 *
 * Throws on filesystem errors. Callers are responsible for catching and
 * logging — atomic-write failures usually indicate disk-full or permission
 * problems and should not be silently swallowed.
 */
export function writeAtomic(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/**
 * JSON-serialise `data` and write atomically. Pretty-printed with 2-space
 * indent and a trailing newline so files are diff-friendly.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  writeAtomic(path, JSON.stringify(data, null, 2) + '\n')
}
