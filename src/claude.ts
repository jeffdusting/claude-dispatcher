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
import { logDispatcher } from './logger.js'

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

/** Snapshot outbox directory listing for diffing after a session run. */
export function snapshotOutbox(): Map<string, number> {
  const snap = new Map<string, number>()
  try {
    for (const name of readdirSync(OUTBOX_DIR)) {
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
  onProgress?: (text: string) => void
}): Promise<SessionResult> {
  const { prompt, sessionId, threadId, onProgress } = opts

  const args: string[] = [
    '-p', prompt,
    '--agent', CLAUDE_AGENT,
    '--model', CLAUDE_MODEL,
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
    resuming: !!sessionId,
    sessionId: sessionId ?? 'new',
    promptPreview: prompt.slice(0, 200),
  })

  // Snapshot outbox before run so we can detect new files
  const outboxBefore = snapshotOutbox()

  const proc: Subprocess = spawn({
    cmd: [CLAUDE_BIN, ...args],
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
    },
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
    throw new Error(errMsg)
  }

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
 */
export async function generateTitle(message: string): Promise<string> {
  const prompt = `Generate a concise thread title (max 80 chars, no quotes) for this task:\n\n${message.slice(0, 500)}`

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
    logDispatcher('generate_title_failed', { exitCode, stderr: stderr.slice(0, 300), stdout: output.slice(0, 300) })
    return message.slice(0, 80)
  }

  const title = output.trim().replace(/^["']|["']$/g, '').slice(0, 100)
  return title || message.slice(0, 80)
}
