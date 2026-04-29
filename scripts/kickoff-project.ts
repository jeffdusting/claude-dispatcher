#!/usr/bin/env bun
/**
 * Launch a new Mode-3 project.
 *
 * Usage (from the CoS, via Bash tool):
 *   bun run dispatcher/scripts/kickoff-project.ts \
 *     --name "Short project name" \
 *     --brief "Full brief text — pass as a single argument" \
 *     --origin-thread 1234567890 \
 *     [--max-workers 3]
 *
 * What it does:
 *   1. Creates a project record (state/projects/<id>.json)
 *   2. Creates a dedicated Discord thread under the origin thread's parent
 *      channel, named "Project: <name>"
 *   3. Registers that thread with the project-manager agent override
 *   4. Drops a kickoff request into the inbox — the dispatcher's watcher
 *      picks it up and spins up the PM in the background
 *   5. Prints JSON { projectId, threadId } to stdout so the CoS can quote
 *      them back to Jeff
 *
 * The CoS remains non-blocking: this script exits in seconds, the PM runs
 * in the dispatcher's process afterwards.
 */

import { parseArgs } from 'util'
import {
  createProject,
  appendProjectLog,
  updateProject,
} from '../src/projects.js'
import {
  createPublicThread,
  getChannelParent,
  postMessage,
} from '../src/discordApi.js'
import { rememberThread } from '../src/threadSessions.js'
import { dropKickoffRequest } from '../src/kickoffInbox.js'
import { resolveEntityForChannel } from '../src/channelEntityMap.js'
import { isEntity, type Entity } from '../src/entity.js'

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    brief: { type: 'string' },
    'origin-thread': { type: 'string' },
    'max-workers': { type: 'string' },
    entity: { type: 'string' },
  },
  strict: true,
})

if (!values.name || !values.brief || !values['origin-thread']) {
  console.error(
    'Usage: kickoff-project.ts --name <n> --brief <b> --origin-thread <id> [--max-workers N] [--entity cbs|wr]',
  )
  process.exit(2)
}

const name = values.name
const brief = values.brief
const originThreadId = values['origin-thread']
const maxWorkers = values['max-workers'] ? Number(values['max-workers']) : 3

if (!Number.isFinite(maxWorkers) || maxWorkers < 1 || maxWorkers > 5) {
  console.error('--max-workers must be 1..5')
  process.exit(2)
}

let explicitEntity: Entity | undefined
if (values.entity !== undefined) {
  if (!isEntity(values.entity)) {
    console.error(`--entity must be 'cbs' or 'wr' (got: ${values.entity})`)
    process.exit(2)
  }
  explicitEntity = values.entity
}

async function main(): Promise<void> {
  // 1. Resolve parent channel of the origin thread first — Phase H wires the
  //    channel-to-entity map so the project descriptor can be created with
  //    the correct entity in one shot. An explicit `--entity` flag wins over
  //    the channel-derived value.
  const parentChannelId = await getChannelParent(originThreadId)
  if (!parentChannelId) {
    throw new Error(
      `Could not resolve parent channel for thread ${originThreadId}`,
    )
  }

  const channelEntity = resolveEntityForChannel(parentChannelId)
  const entity: Entity | undefined = explicitEntity ?? channelEntity ?? undefined

  // 2. Create the project record with the inferred entity (or default if
  //    inference returned no value).
  const project = createProject({
    name,
    brief,
    originThreadId,
    maxParallelWorkers: maxWorkers,
    entity,
  })

  const thread = await createPublicThread({
    parentChannelId,
    name: `Project: ${name}`.slice(0, 100),
    autoArchiveMinutes: 10080, // 7 days
  })

  // 3. Register thread with PM agent override
  rememberThread(thread.id, `Project: ${name}`, {
    agent: 'project-manager',
    projectId: project.id,
  })

  // 4. Update the project record with its thread ID
  updateProject(project.id, (r) => {
    r.threadId = thread.id
    return r
  })
  appendProjectLog(project.id, `Thread created: ${thread.id}`)

  // 5. Post an introductory message so operators can see the project thread
  await postMessage(
    thread.id,
    [
      `**Project launched:** ${name}`,
      `**Project ID:** \`${project.id}\``,
      `**Max parallel workers:** ${maxWorkers}`,
      '',
      'Standing up the project manager...',
    ].join('\n'),
  )

  // 6. Drop the kickoff request for the dispatcher to pick up
  const kickoffPrompt = [
    `You are the Project Manager for project \`${project.id}\` ("${name}").`,
    '',
    `The state file for this project is at: state/projects/${project.id}.json`,
    `Always read it first; it is the source of truth.`,
    '',
    `**Brief from Jeff:**`,
    brief,
    '',
    'Your first action: draft the plan. Write the plan directly into the project state file by',
    'appending entries to the `tasks` array (see projects.ts schema). Each task needs a stable',
    '`id`, `title`, `brief`, and `dependsOn` array. Set the project `status` to "running" once',
    'the plan is saved.',
    '',
    'Then dispatch the first wave of runnable tasks (those with no unmet dependencies), respecting',
    `maxParallelWorkers = ${maxWorkers}. Use the spawn-worker script for each dispatch:`,
    '  bun run dispatcher/scripts/spawn-worker.ts --project <id> --task <taskId>',
    '',
    'After dispatching, schedule an autonomous continuation (CLAUDE_CONTINUE_FILE) in 2-5 minutes',
    'to check worker results. Keep looping: check results, dispatch next wave, continue. When all',
    'tasks are complete, write the project summary, set status to "complete", and stop scheduling',
    'continuations.',
    '',
    'Post a short status tick to the Discord thread after each major step.',
  ].join('\n')

  dropKickoffRequest({
    projectId: project.id,
    originThreadId,
    projectThreadId: thread.id,
    kickoffPrompt,
    createdAt: new Date().toISOString(),
  })

  // 7. Emit JSON for the CoS caller
  console.log(JSON.stringify({
    projectId: project.id,
    threadId: thread.id,
    parentChannelId,
    maxWorkers,
    entity: project.entity,
    entitySource: explicitEntity ? 'explicit' : channelEntity ? 'channel-map' : 'default',
  }, null, 2))
}

main().catch((err) => {
  console.error(`kickoff-project failed: ${err}`)
  process.exit(1)
})
