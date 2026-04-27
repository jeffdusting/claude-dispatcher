/**
 * Trace block capture (Phase A.11, Δ DA-013, OD-027).
 *
 * Architecture v2.1 §6.6: every substantive agent output emits a structured
 * trace block. The four-hourly ingestion pipeline (Phase J.0) reads these,
 * redacts PII, partitions by EA-and-entity, and feeds redacted content into
 * the appropriate KB.
 *
 * A.11 establishes the data shape so end-to-end audit reconstruction has a
 * complete capture surface from day one. Trace redaction and per-EA
 * partitioning is explicitly Phase J.0 work and out of scope here — this
 * module only writes raw blocks. Storage at STATE_DIR/traces-original/
 * matches the architecture document's path; permissions are 0700 on the
 * directory so the originals are not world-readable.
 *
 * Every block carries `correlationId` from the active correlation scope
 * (correlationContext.ts). The audit reconstruction tool (post-migration)
 * will pivot on this field to walk the chain Discord → log → worker stdout
 * → trace block → Drive artefact.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { getCorrelationId } from './correlationContext.js'

export const TRACES_ORIGINAL_DIR = join(STATE_DIR, 'traces-original')

mkdirSync(TRACES_ORIGINAL_DIR, { recursive: true, mode: 0o700 })

export interface TraceBlock {
  /** Discriminator for the kind of capture (e.g. `claude_session`, `paperclip_dispatch`). */
  type: string
  /** Always populated when a correlation scope is active. */
  correlationId?: string
  [key: string]: unknown
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function traceFile(): string {
  return join(TRACES_ORIGINAL_DIR, `${dateStr()}-traces.jsonl`)
}

/**
 * Append a trace block. The correlationId is read from the active scope
 * unless the caller passes one explicitly. Best-effort: any I/O failure
 * is swallowed after a stderr note — trace capture must never break the
 * happy path.
 */
export function appendTraceBlock(block: TraceBlock): void {
  const correlationId = block.correlationId ?? getCorrelationId()
  const entry = {
    timestamp: new Date().toISOString(),
    ...(correlationId ? { correlationId } : {}),
    ...block,
  }
  try {
    appendFileSync(traceFile(), JSON.stringify(entry) + '\n')
  } catch (err) {
    process.stderr.write(`trace: append failed: ${err}\n`)
  }
}
