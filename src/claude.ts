/**
 * Claude CLI wrapper — spawns and streams Claude Code sessions.
 *
 * Uses `claude -p` with `--output-format stream-json` to get real-time
 * events. Each session runs as a child process.
 */

import { spawn, type Subprocess } from 'bun'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  CLAUDE_BIN,
  CLAUDE_AGENT,
  CLAUDE_MODEL,
  ALLOWED_TOOLS,
  PROJECT_DIR,
  OUTBOX_DIR,
} from './config.js'
import { continuationFilePath } from './continuation.js'
import { getThreadRecord } from './threadSessions.js'
import {
  ALL_SUPABASE_ENV_NAMES,
  type Entity,
  SUPABASE_ENV_NAMES,
} from './entity.js'
import { resolveEntityForThread } from './entityResolver.js'
import {
  withUpstream,
  recordBreakerSuccess,
  recordBreakerFailure,
} from './circuitBreaker.js'
import { isTransientError } from './retryWithBackoff.js'
import {
  classifyAnthropicError,
  recordCapHitFromError,
} from './anthropicCap.js'
import {
  registerWorker,
  recordHeartbeat,
  unregisterWorker,
} from './workerRegistry.js'
import { acquire as acquireWorkerSlot, release as releaseWorkerSlot } from './concurrencyGate.js'
import { logDispatcher } from './logger.js'

/**
 * Marker thrown when the concurrent-worker cap is hit and the 30-second
 * queue wait expires (Phase A.9.5, Δ D-014). Callers should catch this
 * and surface a "busy" message to the user rather than rethrow.
 */
export class WorkerSlotUnavailableError extends Error {
  constructor() {
    super('No worker slot available within timeout')
    this.name = 'WorkerSlotUnavailableError'
  }
}

export interface ClaudeMessage {
  type: string
  session_id?: string
  message?: {
    role: string
    content: Array<{ type: string; text?: string; name?: string; input?: unknown }>
  }
  result?: string
  cost_usd?: number
  duration_ms?: number
  turns?: number
}

export interface SessionResult {
  sessionId: string | null
  response: string
  cost: number | null
  turns: number | null
  durationMs: number | null
  toolsUsed: string[]
  /** Set to true if --resume failed and we need to retry without it */
  resumeFailed?: boolean
}

/** Tracks files that appeared in outbox/ during a session run */
export interface OutputFile {
  path: string
  name: string
}

/**
 * Should this outbox entry be considered an attachable deliverable?
 *
 * Filters out:
 *  - directories (Discord.js throws FileNotFound when given a directory path)
 *  - dotfiles (.DS_Store etc.)
 *  - Word/Excel lock files (~$*)
 *  - other non-regular files (symlinks to nowhere, sockets, etc.)
 */
function isAttachableOutboxEntry(name: string): boolean {
  if (name.startsWith('.')) return false
  if (name.startsWith('~$')) return false
  let st
  try {
    st = statSync(join(OUTBOX_DIR, name))
  } catch {
    return false
  }
  return st.isFile()
}

/** Snapshot outbox directory listing for diffing after a session run. */
export function snapshotOutbox(): Map<string, number> {
  const snap = new Map<string, number>()
  try {
    for (const name of readdirSync(OUTBOX_DIR)) {
      if (!isAttachableOutboxEntry(name)) continue
      try {
        snap.set(name, statSync(join(OUTBOX_DIR, name)).mtimeMs)
      } catch {}
    }
  } catch {}
  return snap
}

/** Find files that are new or modified since a snapshot. */
export function diffOutbox(before: Map<string, number>): OutputFile[] {
  const results: OutputFile[] = []
  try {
    for (const name of readdirSync(OUTBOX_DIR)) {
      if (!isAttachableOutboxEntry(name)) continue
      try {
        const mtime = statSync(join(OUTBOX_DIR, name)).mtimeMs
        const prev = before.get(name)
        if (prev === undefined || mtime > prev) {
          results.push({ path: join(OUTBOX_DIR, name), name })
        }
      } catch {}
    }
  } catch {}
  return results
}

/**
 * Spawn a new Claude session or resume an existing one.
 *
 * onProgress fires for each assistant text chunk — use it to update
 * a "Working..." message in Discord.
 *
 * If --resume fails (stale session), returns { resumeFailed: true }
 * so the caller can retry without a session ID.
 */
export async function runSession(opts: {
  prompt: string
  sessionId?: string | null
  threadId: string
  /** Claude agent to run. Defaults to CLAUDE_AGENT (chief-of-staff). */
  agent?: string
  /** Claude model to run. Defaults to CLAUDE_MODEL. */
  model?: string
  /**
   * Entity context for credential scoping (Phase A.5.3, Δ DA-005). Determines
   * which Supabase service-role key the worker sees. If unset, the entity
   * is resolved from the thread's project descriptor (Phase A.6.6) — this
   * is the path most callers exercise. DEFAULT_ENTITY remains the final
   * fallback when no project is associated with the thread.
   */
  entity?: Entity
  onProgress?: (text: string) => void
}): Promise<SessionResult> {
  const { prompt, sessionId, threadId, onProgress } = opts
  // Agent/model resolution order: explicit opts > per-thread override > env default.
  const threadRecord = getThreadRecord(threadId)
  const agent = opts.agent ?? threadRecord?.agent ?? CLAUDE_AGENT
  const model = opts.model ?? CLAUDE_MODEL
  const entity: Entity = opts.entity ?? resolveEntityForThread(threadId)

  // Concurrent-worker cap (Phase A.9.5, Δ D-014). Gate every spawn through
  // the semaphore so a brief spike queues for up to 30s before falling back
  // to a busy response. The slot is released in finally so failures cannot
  // leak slots.
  const slot = await acquireWorkerSlot({ timeoutMs: 30_000, reason: `runSession:${threadId}` })
  if (!slot.acquired) {
    logDispatcher('worker_slot_unavailable', { threadId, waitedMs: slot.waitedMs })
    throw new WorkerSlotUnavailableError()
  }

  const args: string[] = [
    '-p', prompt,
    '--agent', agent,
    '--model', model,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--allowed-tools', ALLOWED_TOOLS,
    '--verbose',
  ]

  if (sessionId) {
    args.push('--resume', sessionId)
  } else {
    args.push('--name', `generic-${threadId.slice(-6)}`)
  }

  const startTime = Date.now()

  logDispatcher('claude_spawn', {
    threadId,
    agent,
    model,
    entity,
    resuming: !!sessionId,
    sessionId: sessionId ?? 'new',
    promptPreview: prompt.slice(0, 200),
  })

  // Continuation file path — per-thread, passed via env so the agent can
  // write it from inside its session to signal an autonomous continuation.
  let continueFile: string | null = null
  try {
    continueFile = continuationFilePath(threadId)
  } catch {
    // Malformed threadId; continuation disabled for this run.
  }

  // Outer try/finally guarantees releaseWorkerSlot fires for every spawn,
  // independent of which exit path is taken (resume-failed return,
  // throw-on-error, normal return).
  try {
  const proc: Subprocess = spawn({
    cmd: [CLAUDE_BIN, ...args],
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: scopeWorkerEnv(entity, {
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      CLAUDE_THREAD_ID: threadId,
      CLAUDE_ENTITY: entity,
      ...(continueFile ? { CLAUDE_CONTINUE_FILE: continueFile } : {}),
      // When the thread belongs to a Mode-3 project, surface the project ID
      // so the PM and any in-session tools can locate the state file.
      ...(threadRecord?.projectId
        ? { CLAUDE_PROJECT_ID: threadRecord.projectId }
        : {}),
    }),
  })

  registerWorker({
    threadId,
    pid: proc.pid ?? -1,
    projectId: threadRecord?.projectId ?? null,
    entity,
    startedAt: startTime,
  })

  let responseText = ''
  let capturedSessionId: string | null = sessionId ?? null
  let cost: number | null = null
  let turns: number | null = null
  let toolsUsed: string[] = []

  // Read stdout as stream-json (newline-delimited JSON)
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()! // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg: ClaudeMessage = JSON.parse(line)
          // Stream chunk arrived — bump the worker registry heartbeat
          // (Δ D-004, Phase A.9.4) so the orphan-detection sweep does not
          // mark a long-but-progressing turn as hung.
          recordHeartbeat(threadId)
          switch (msg.type) {
            case 'assistant': {
              if (msg.message?.content) {
                for (const block of msg.message.content) {
                  if (block.type === 'text' && block.text) {
                    responseText += block.text
                    onProgress?.(block.text)
                  }
                  // Track tool usage for progress updates
                  if (block.type === 'tool_use' && block.name) {
                    toolsUsed.push(block.name)
                    onProgress?.(``) // signal activity even without text
                  }
                }
              }
              break
            }
            case 'result': {
              if (msg.session_id) capturedSessionId = msg.session_id
              if (msg.result) responseText = msg.result
              cost = msg.cost_usd ?? null
              turns = msg.turns ?? null
              break
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Wait for process to exit
  const exitCode = await proc.exited

  // Capture stderr for diagnostics
  let stderr = ''
  try {
    stderr = await new Response(proc.stderr).text()
  } catch {}

  const durationMs = Date.now() - startTime
  const uniqueTools = [...new Set(toolsUsed)]

  // Detect stale session — resume failed
  if (exitCode !== 0 && sessionId && isResumeFailed(stderr)) {
    logDispatcher('claude_resume_failed', { threadId, sessionId, durationMs, stderr: stderr.slice(0, 300) })
    unregisterWorker(threadId, 'completed', 'resume_failed')
    return {
      sessionId: null,
      response: '',
      cost: null,
      turns: null,
      durationMs,
      toolsUsed: uniqueTools,
      resumeFailed: true,
    }
  }

  if (exitCode !== 0 && !responseText) {
    const errMsg = stderr.slice(0, 500) || `claude exited with code ${exitCode}`
    logDispatcher('claude_error', { threadId, exitCode, durationMs, stderr: errMsg })
    // Classify the upstream error so the resilience layer treats billing
    // failures separately from per-request 5xx (Phase A.9.9, OD-012). The
    // 24 April 2026 monthly-cap incident showed that retrying a billing
    // failure wastes budget; the marker file pauses the kickoff cycle and
    // the tier-2 alert reaches the operator.
    const errClass = classifyAnthropicError(errMsg)
    if (errClass === 'monthly-cap') {
      recordCapHitFromError(errMsg)
    } else if (errClass === 'transient' || isTransientError(new Error(errMsg))) {
      // Anthropic-upstream breaker: a non-zero exit with no captured
      // response is the failure signature for the 25 April 2026 529
      // incident class (mid-stream over-capacity errors). Auto-retrying
      // the subprocess is unsafe (potential double-charged work, session-id
      // mismatch on partial success); we record the failure for breaker
      // visibility and let the gateway's stale-session retry path handle
      // the recoverable case.
      recordBreakerFailure('anthropic', errMsg)
    }
    unregisterWorker(threadId, 'completed', `exit_${exitCode}`)
    throw new Error(errMsg)
  }

  recordBreakerSuccess('anthropic')
  unregisterWorker(threadId, 'completed')

  logDispatcher('claude_done', {
    threadId,
    sessionId: capturedSessionId,
    responseLength: responseText.length,
    cost,
    turns,
    durationMs,
    toolsUsed: uniqueTools,
  })

  return {
    sessionId: capturedSessionId,
    response: responseText,
    cost,
    turns,
    durationMs,
    toolsUsed: uniqueTools,
  }
  } finally {
    releaseWorkerSlot()
  }
}

/**
 * Build the worker process environment with KB credentials scoped to the
 * worker's entity (Phase A.5.3, Δ DA-005). The worker sees:
 *   - The full parent environment, EXCEPT
 *   - Cross-entity Supabase variables are removed.
 *   - Entity-scoped Supabase variables are passed through under their
 *     entity-specific names so the supabase-query skill resolves them per
 *     OD-031 §5 (e.g. CBS_SUPABASE_SERVICE_ROLE_KEY for entity=cbs).
 *
 * The skill itself is responsible for selecting the variable name from the
 * `entity` parameter; the dispatcher's job is the credential reduction.
 */
export function scopeWorkerEnv(
  entity: Entity,
  extras: Record<string, string>,
): Record<string, string> {
  const allow = new Set<string>([
    SUPABASE_ENV_NAMES[entity].url,
    SUPABASE_ENV_NAMES[entity].serviceRoleKey,
  ])

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // Drop any cross-entity Supabase var that is not the entity's own.
    if (ALL_SUPABASE_ENV_NAMES.includes(k) && !allow.has(k)) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extras)) {
    env[k] = v
  }
  return env
}

/** Check if stderr indicates a failed resume (stale/missing session). */
function isResumeFailed(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return (
    lower.includes('session not found') ||
    lower.includes('could not find session') ||
    lower.includes('no session') ||
    lower.includes('invalid session')
  )
}

/**
 * Generate a short thread title from a message using a fast model.
 *
 * Wrapped in `withUpstream('anthropic')` (Phase A.9.1/A.9.2): titles are
 * short, idempotent prompts where the retry+breaker pair is cheap and
 * useful. Retry exhaustion or open breaker falls back to the truncated
 * message — title generation is non-essential, so the breaker should not
 * propagate failures up the stack.
 */
export async function generateTitle(message: string): Promise<string> {
  const prompt = `Generate a concise thread title (max 80 chars, no quotes) for this task:\n\n${message.slice(0, 500)}`

  try {
    return await withUpstream('anthropic', async () => {
      const proc = spawn({
        cmd: [
          CLAUDE_BIN,
          '-p', prompt,
          '--model', 'haiku',
          '--output-format', 'text',
          '--no-session-persistence',
        ],
        cwd: PROJECT_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
      })

      const [output, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        logDispatcher('generate_title_failed', {
          exitCode,
          stderr: stderr.slice(0, 300),
          stdout: output.slice(0, 300),
        })
        // Throw so the retry helper can decide whether the error is
        // transient. Non-transient errors propagate to the outer catch
        // and fall back to the truncated message.
        throw new Error(stderr.slice(0, 300) || `claude exited with code ${exitCode}`)
      }

      const title = output.trim().replace(/^["']|["']$/g, '').slice(0, 100)
      return title || message.slice(0, 80)
    }, { operation: 'generate_title', attempts: 3 })
  } catch {
    return message.slice(0, 80)
  }
}
