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
  getChannelName,
  postMessage,
} from '../src/discordApi.js'
import { rememberThread } from '../src/threadSessions.js'
import { dropKickoffRequest } from '../src/kickoffInbox.js'
import { dropTenderRequest } from '../src/tenderQueue.js'
import { resolveEntityForChannel } from '../src/channelEntityMap.js'
import { classifyTender } from '../src/tenderClassifier.js'
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

  // 1b. Tender classification (Phase H §12.3). The classifier reads the
  //     brief, the origin channel name, and the resolved entity. If it
  //     fires, we route into the tender-queue rather than the general
  //     kickoff inbox; otherwise the existing path runs unchanged.
  const channelName = await getChannelName(parentChannelId).catch(() => null)
  const tender = classifyTender({
    brief,
    channelName,
    entity: entity ?? null,
  })

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
    name: tender.isTender
      ? `Tender: ${name}`.slice(0, 100)
      : `Project: ${name}`.slice(0, 100),
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

  // 5. Post an introductory message so operators can see the project thread.
  //    The tender path uses a distinct opening line so audit logs are obvious
  //    at a glance; otherwise the message shape is identical.
  await postMessage(
    thread.id,
    tender.isTender
      ? [
          `**Tender opportunity routed:** ${name}`,
          `**Project ID:** \`${project.id}\``,
          `**Recommended agent:** ${tender.recommendedAgent}`,
          `**Signals:** ${tender.signals.join(', ')}`,
          '',
          'Tender handler will pick this up...',
        ].join('\n')
      : [
          `**Project launched:** ${name}`,
          `**Project ID:** \`${project.id}\``,
          `**Max parallel workers:** ${maxWorkers}`,
          '',
          'Standing up the project manager...',
        ].join('\n'),
  )

  // 6. Drop the kickoff request — into the tender queue when classified,
  //    otherwise into the general kickoff inbox.
  if (tender.isTender) {
    const tenderPrompt = buildTenderPrompt({
      projectId: project.id,
      name,
      brief,
      recommendedAgent: tender.recommendedAgent ?? 'office-management',
      signals: tender.signals,
      maxWorkers,
    })
    dropTenderRequest({
      projectId: project.id,
      originThreadId,
      projectThreadId: thread.id,
      kickoffPrompt: tenderPrompt,
      createdAt: new Date().toISOString(),
      entity: project.entity,
      recommendedAgent: tender.recommendedAgent ?? 'office-management',
      signals: tender.signals,
    })
  } else {
    const kickoffPrompt = buildPmKickoffPrompt({
      projectId: project.id,
      name,
      brief,
      maxWorkers,
    })
    dropKickoffRequest({
      projectId: project.id,
      originThreadId,
      projectThreadId: thread.id,
      kickoffPrompt,
      createdAt: new Date().toISOString(),
    })
  }

  // 7. Emit JSON for the CoS caller
  console.log(JSON.stringify({
    projectId: project.id,
    threadId: thread.id,
    parentChannelId,
    maxWorkers,
    entity: project.entity,
    entitySource: explicitEntity ? 'explicit' : channelEntity ? 'channel-map' : 'default',
    routedTo: tender.isTender ? 'tender-queue' : 'kickoff-inbox',
    tenderSignals: tender.signals,
    recommendedAgent: tender.recommendedAgent,
  }, null, 2))
}

function buildPmKickoffPrompt(opts: {
  projectId: string
  name: string
  brief: string
  maxWorkers: number
}): string {
  return [
    `You are the Project Manager for project \`${opts.projectId}\` ("${opts.name}").`,
    '',
    `The state file for this project is at: state/projects/${opts.projectId}.json`,
    `Always read it first; it is the source of truth.`,
    '',
    `**Brief from Jeff:**`,
    opts.brief,
    '',
    'Your first action: draft the plan. Write the plan directly into the project state file by',
    'appending entries to the `tasks` array (see projects.ts schema). Each task needs a stable',
    '`id`, `title`, `brief`, and `dependsOn` array. Set the project `status` to "running" once',
    'the plan is saved.',
    '',
    'Then dispatch the first wave of runnable tasks (those with no unmet dependencies), respecting',
    `maxParallelWorkers = ${opts.maxWorkers}. Use the spawn-worker script for each dispatch:`,
    '  bun run dispatcher/scripts/spawn-worker.ts --project <id> --task <taskId>',
    '',
    'After dispatching, schedule an autonomous continuation (CLAUDE_CONTINUE_FILE) in 2-5 minutes',
    'to check worker results. Keep looping: check results, dispatch next wave, continue. When all',
    'tasks are complete, write the project summary, set status to "complete", and stop scheduling',
    'continuations.',
    '',
    'Post a short status tick to the Discord thread after each major step.',
  ].join('\n')
}

function buildTenderPrompt(opts: {
  projectId: string
  name: string
  brief: string
  recommendedAgent: 'office-management' | 'tender-review'
  signals: string[]
  maxWorkers: number
}): string {
  const agentLine = opts.recommendedAgent === 'tender-review'
    ? 'Recommended first agent: WaterRoads Tender Review (substantive review of opportunity fit, scope, capability, response approach).'
    : 'Recommended first agent: CBS Office Management (triage the opportunity, route to the right reviewer or principal, and capture the closing date in the calendar).'
  return [
    `You are the Project Manager for tender opportunity \`${opts.projectId}\` ("${opts.name}").`,
    '',
    `The state file for this project is at: state/projects/${opts.projectId}.json`,
    `Always read it first; it is the source of truth. The descriptor's entity field has been set`,
    `from the origin channel; the tender classifier signals were: ${opts.signals.join(', ')}.`,
    '',
    `**Brief (likely a forwarded tender notification):**`,
    opts.brief,
    '',
    agentLine,
    '',
    'Your first action: draft a triage plan. Capture the tender essentials (issuer, reference,',
    'scope summary, closing date, submission method) by reading the brief, then write tasks into',
    'the project state file. The first task should always be a triage pass owned by the recommended',
    'agent above; subsequent tasks (response drafting, capability gap review, pricing) follow only',
    'if triage decides the opportunity is worth pursuing.',
    '',
    `maxParallelWorkers = ${opts.maxWorkers}. Use the spawn-worker script with the recommended agent:`,
    '  bun run dispatcher/scripts/spawn-worker.ts --project <id> --task <taskId> [--agent <agent>]',
    '',
    'After triage completes, post the recommendation (pursue or decline) to the Discord thread for',
    'the principal\'s decision. Do not progress to drafting work without explicit go-ahead.',
  ].join('\n')
}

main().catch((err) => {
  console.error(`kickoff-project failed: ${err}`)
  process.exit(1)
})
