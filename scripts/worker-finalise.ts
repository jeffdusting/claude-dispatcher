#!/usr/bin/env bun
/**
 * Finalise a worker — called by the bash wrapper in spawn-worker.ts after
 * the Claude invocation exits.
 *
 * Reads the raw output file, writes a structured result JSON, updates the
 * project state file's task entry (status=complete|failed, resultSummary,
 * completedAt), and posts a short completion note to the project's
 * Discord thread.
 *
 * Usage:
 *   bun run dispatcher/scripts/worker-finalise.ts \
 *     --project p-abc123 --task t1 --exit 0
 */

import { parseArgs } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getProject, updateProject, appendProjectLog, PROJECTS_DIR } from '../src/projects.js'
import { postMessage } from '../src/discordApi.js'

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    task: { type: 'string' },
    exit: { type: 'string' },
  },
  strict: true,
})

if (!values.project || !values.task || values.exit === undefined) {
  console.error('Usage: worker-finalise.ts --project <id> --task <taskId> --exit <code>')
  process.exit(2)
}

const projectId = values.project
const taskId = values.task
const exitCode = Number(values.exit)

async function main(): Promise<void> {
  const project = getProject(projectId)
  if (!project) {
    console.error(`Project not found: ${projectId}`)
    return
  }

  const workersDir = join(PROJECTS_DIR, `${projectId}.workers`)
  const rawPath = join(workersDir, `${taskId}.raw`)
  const resultPath = join(workersDir, `${taskId}.json`)

  const raw = existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : ''
  const success = exitCode === 0 && raw.length > 0

  const result = {
    projectId,
    taskId,
    success,
    exitCode,
    response: raw,
    completedAt: Date.now(),
  }
  writeFileSync(resultPath, JSON.stringify(result, null, 2))

  const summary = raw.slice(0, 300)

  const updated = updateProject(projectId, (r) => {
    const t = r.tasks.find((x) => x.id === taskId)
    if (t) {
      t.status = success ? 'complete' : 'failed'
      t.completedAt = Date.now()
      t.resultSummary = summary
      if (!success) {
        t.error = `Worker exited with code ${exitCode}`
      }
    }
    return r
  })

  appendProjectLog(
    projectId,
    success
      ? `Task ${taskId} complete: ${updated.tasks.find((t) => t.id === taskId)?.title ?? taskId}`
      : `Task ${taskId} FAILED (exit ${exitCode})`,
  )

  // Post a terse completion note to the project thread
  if (updated.threadId) {
    const icon = success ? '✅' : '❌'
    const title = updated.tasks.find((t) => t.id === taskId)?.title ?? taskId
    try {
      await postMessage(
        updated.threadId,
        `${icon} Task \`${taskId}\` ${success ? 'complete' : 'failed'}: ${title}`,
      )
    } catch (err) {
      console.error(`Failed to post completion to Discord: ${err}`)
    }
  }
}

main().catch((err) => {
  console.error(`worker-finalise failed: ${err}`)
  process.exit(1)
})
