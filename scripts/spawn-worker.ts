#!/usr/bin/env bun
/**
 * Spawn a worker Claude instance for a single task inside a project.
 *
 * Called by the Project Manager from inside its session. The worker runs
 * in the BACKGROUND (detached) so the PM can spawn multiple workers in
 * parallel without blocking. The worker writes its final result back to
 * the project state file via worker-finalise.ts once it completes.
 *
 * Usage (from PM via Bash):
 *   bun run dispatcher/scripts/spawn-worker.ts --project p-abc123 --task t1
 *
 * Exit codes:
 *   0   — worker dispatched successfully (detached)
 *   1   — configuration error (missing project/task, unmet deps, etc.)
 *   3   — at concurrency cap — PM should wait for workers to complete
 *
 * Prints a single line of JSON on success: { projectId, taskId, workerId, status }
 */

import { parseArgs } from 'util'
import { spawn } from 'bun'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  getProject,
  updateProject,
  appendProjectLog,
  countRunningTasks,
  PROJECTS_DIR,
} from '../src/projects.js'

const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude')
const PROJECT_DIR = join(homedir(), 'claude-workspace', 'generic')
const FINALISE_SCRIPT = join(PROJECT_DIR, 'dispatcher', 'scripts', 'worker-finalise.ts')

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  'Agent', 'WebSearch', 'WebFetch', 'ToolSearch', 'Skill',
].join(',')

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    task: { type: 'string' },
    foreground: { type: 'boolean', default: false },
  },
  strict: true,
})

if (!values.project || !values.task) {
  console.error('Usage: spawn-worker.ts --project <id> --task <taskId>')
  process.exit(2)
}

const projectId = values.project
const taskId = values.task
const foreground = values.foreground ?? false

async function main(): Promise<number> {
  const project = getProject(projectId)
  if (!project) {
    console.error(`Project not found: ${projectId}`)
    return 1
  }

  const task = project.tasks.find((t) => t.id === taskId)
  if (!task) {
    console.error(`Task not found: ${taskId} in project ${projectId}`)
    return 1
  }

  if (task.status !== 'queued') {
    console.error(`Task ${taskId} is not queued (status=${task.status}). Skipping.`)
    return 1
  }

  // Check concurrency ceiling BEFORE transitioning to running
  const running = countRunningTasks(project)
  if (running >= project.maxParallelWorkers) {
    console.error(
      `At capacity: ${running}/${project.maxParallelWorkers} workers already running.`,
    )
    return 3
  }

  // Check dependencies
  const doneIds = new Set(
    project.tasks.filter((t) => t.status === 'complete').map((t) => t.id),
  )
  const unmet = task.dependsOn.filter((d) => !doneIds.has(d))
  if (unmet.length > 0) {
    console.error(`Task ${taskId} has unmet deps: ${unmet.join(', ')}`)
    return 1
  }

  // Prepare per-task workspace
  const workersDir = join(PROJECTS_DIR, `${projectId}.workers`)
  mkdirSync(workersDir, { recursive: true })
  const rawOutputPath = join(workersDir, `${taskId}.raw`)
  const resultPath = join(workersDir, `${taskId}.json`)

  // Flip task to running and record result path
  updateProject(projectId, (r) => {
    const t = r.tasks.find((x) => x.id === taskId)
    if (t) {
      t.status = 'running'
      t.startedAt = Date.now()
      t.resultPath = resultPath
    }
    return r
  })
  appendProjectLog(projectId, `Worker dispatched for task ${taskId}: ${task.title}`)

  const model = task.model ?? 'sonnet'
  const allowedTools = task.allowedTools ?? DEFAULT_ALLOWED_TOOLS

  const workerPrompt = [
    `<project id="${projectId}" task="${taskId}">`,
    `You are a worker on project "${project.name}". Your task is defined below.`,
    `Your ONLY job is to complete this task and return a focused response.`,
    `Do NOT try to advance the broader project — the Project Manager handles that.`,
    '',
    `**Task:** ${task.title}`,
    '',
    `**Brief:**`,
    task.brief,
    '',
    `**Project context (for reference):**`,
    project.brief.slice(0, 1500),
    '',
    `When complete, your response should be concise, structured, and directly usable.`,
    `If you produce files, save them to the outbox/ directory.`,
    `</project>`,
  ].join('\n')

  // Bash wrapper:
  //   1. Run claude, capture stdout+stderr to rawOutputPath
  //   2. Capture exit code
  //   3. Run finalise script which reads raw file, writes structured
  //      result, updates project state, posts to Discord
  const escaped = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

  const wrapper = [
    `(`,
    `  ${escaped(CLAUDE_BIN)} -p ${escaped(workerPrompt)} \\`,
    `    --model ${escaped(model)} \\`,
    `    --output-format text \\`,
    `    --permission-mode bypassPermissions \\`,
    `    --allowed-tools ${escaped(allowedTools)} \\`,
    `    --name worker-${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    `) > ${escaped(rawOutputPath)} 2>&1`,
    `EXIT=$?`,
    `bun run ${escaped(FINALISE_SCRIPT)} --project ${escaped(projectId)} --task ${escaped(taskId)} --exit $EXIT`,
  ].join('\n')

  if (foreground) {
    const proc = spawn({
      cmd: ['bash', '-c', wrapper],
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: PROJECT_DIR,
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (stdout) console.log(stdout)
    if (stderr) console.error(stderr)
  } else {
    const proc = spawn({
      cmd: ['bash', '-c', wrapper],
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      cwd: PROJECT_DIR,
    })
    // Unref so this process can exit while the worker continues
    ;(proc as unknown as { unref?: () => void }).unref?.()

    console.log(JSON.stringify({
      projectId,
      taskId,
      workerId: String(proc.pid ?? 'unknown'),
      status: 'dispatched',
      rawOutputPath,
      resultPath,
    }))
  }

  return 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`spawn-worker failed: ${err}`)
  process.exit(1)
})
