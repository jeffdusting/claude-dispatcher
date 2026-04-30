#!/usr/bin/env bun
/**
 * Trace redaction CLI (Phase J.0).
 *
 * Reads JSONL trace files from `STATE_DIR/traces-original/` and writes
 * a redacted copy under `STATE_DIR/traces/<eaOwner>/`. The dry-run
 * mode reports what would be redacted without writing the output —
 * useful for verifying the pattern set against new trace shapes before
 * mutating production state.
 *
 * Per-EA partitioning is driven by the `owningEA` field on the project
 * descriptor referenced by each trace block's `projectId`. The legacy
 * alias `eaOwner` is read tolerantly. When neither field is present
 * (pre-J.1a descriptors) or the trace block is unbound, the redactor
 * falls back to the EA passed via --ea (default: jeff, Alex's partition).
 *
 * Usage:
 *   bun run dispatcher/scripts/redact-traces.ts [--dry-run] [--ea <ea>]
 *     [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *
 * Examples:
 *   # Dry-run a single day's traces, default EA partition
 *   bun run dispatcher/scripts/redact-traces.ts --dry-run --since 2026-04-29 --until 2026-04-29
 *
 *   # Wet-run all available original traces under Quinn's partition
 *   bun run dispatcher/scripts/redact-traces.ts --ea quinn
 */

import { parseArgs } from 'util'
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../src/config.js'
import { TRACES_ORIGINAL_DIR } from '../src/trace.js'
import { redactTraceBlock, type RedactionClass } from '../src/traceRedactor.js'
import { getProject } from '../src/projects.js'

const TRACES_REDACTED_ROOT = join(STATE_DIR, 'traces')

const DEFAULT_EA = 'jeff' // Alex's partition under J.1a scaffolding

interface CliOptions {
  dryRun: boolean
  ea: string
  since?: string
  until?: string
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      ea: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
    },
    strict: true,
  })
  return {
    dryRun: values['dry-run'] === true,
    ea: values.ea ?? DEFAULT_EA,
    since: values.since,
    until: values.until,
  }
}

function isWithinRange(filename: string, since?: string, until?: string): boolean {
  // File pattern: YYYY-MM-DD-traces.jsonl
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})-traces\.jsonl$/)
  if (!m) return false
  const date = m[1]
  if (since && date < since) return false
  if (until && date > until) return false
  return true
}

interface ProjectEaResolver {
  resolve: (projectId: string | undefined) => string
}

function makeProjectEaResolver(defaultEa: string): ProjectEaResolver {
  const cache = new Map<string, string>()
  return {
    resolve(projectId) {
      if (!projectId) return defaultEa
      if (cache.has(projectId)) return cache.get(projectId)!
      const project = getProject(projectId)
      // owningEA is the canonical v3 field (Migration Plan §14.3.2).
      // eaOwner is read as a legacy alias for descriptors written ad-hoc
      // by older scripts. Descriptors written before either field
      // existed fall back to the default partition.
      const proj = project as unknown as { owningEA?: unknown; eaOwner?: unknown }
      const ea =
        typeof proj?.owningEA === 'string' && proj.owningEA.length > 0
          ? proj.owningEA
          : typeof proj?.eaOwner === 'string' && proj.eaOwner.length > 0
            ? proj.eaOwner
            : defaultEa
      cache.set(projectId, ea)
      return ea
    },
  }
}

function aggregateCounts(into: Record<RedactionClass, number>, from: Record<RedactionClass, number>): void {
  for (const k of Object.keys(from) as RedactionClass[]) {
    into[k] = (into[k] ?? 0) + from[k]
  }
}

function emptyCounts(): Record<RedactionClass, number> {
  return {
    email: 0,
    phone: 0,
    address: 0,
    'credit-card': 0,
    passport: 0,
    medicare: 0,
    'bsb-account': 0,
    abn: 0,
    acn: 0,
    name: 0,
  }
}

async function main(): Promise<void> {
  const opts = parseCli()

  if (!existsSync(TRACES_ORIGINAL_DIR)) {
    console.error(`No traces-original directory at ${TRACES_ORIGINAL_DIR}; nothing to do.`)
    process.exit(0)
  }

  const files = readdirSync(TRACES_ORIGINAL_DIR)
    .filter((f) => isWithinRange(f, opts.since, opts.until))
    .sort()

  if (files.length === 0) {
    console.error('No matching trace files; nothing to do.')
    process.exit(0)
  }

  const resolver = makeProjectEaResolver(opts.ea)
  const totals = emptyCounts()
  let totalLines = 0
  let totalRedactedLines = 0

  // Group output by EA so a single source file's lines can fan out to
  // multiple EA partitions. We write each partition once at the end
  // (atomic-ish — single writeFileSync per file in non-dry-run).
  const outputByPartition = new Map<string, string[]>() // key = `<ea>/<filename>`

  for (const filename of files) {
    const inputPath = join(TRACES_ORIGINAL_DIR, filename)
    const raw = readFileSync(inputPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)

    for (const line of lines) {
      totalLines += 1
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        console.error(`skip non-JSON line in ${filename}: ${String(err).slice(0, 100)}`)
        continue
      }

      const projectId = (parsed as { projectId?: unknown }).projectId
      const ea = resolver.resolve(typeof projectId === 'string' ? projectId : undefined)

      const result = redactTraceBlock(parsed)
      aggregateCounts(totals, result.counts)
      const blockHadRedactions = Object.values(result.counts).some((n) => n > 0)
      if (blockHadRedactions) totalRedactedLines += 1

      const key = `${ea}/${filename}`
      const bucket = outputByPartition.get(key) ?? []
      bucket.push(JSON.stringify(result.block))
      outputByPartition.set(key, bucket)
    }
  }

  if (opts.dryRun) {
    console.log(JSON.stringify(
      {
        mode: 'dry-run',
        filesScanned: files.length,
        totalLines,
        linesWithRedactions: totalRedactedLines,
        totalsByClass: totals,
        partitionsThatWouldBeWritten: Array.from(outputByPartition.keys()).sort(),
      },
      null,
      2,
    ))
    return
  }

  for (const [key, bucket] of outputByPartition) {
    const [ea, filename] = key.split('/')
    const outDir = join(TRACES_REDACTED_ROOT, ea)
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, filename)
    writeFileSync(outPath, bucket.join('\n') + '\n')
  }

  console.log(JSON.stringify(
    {
      mode: 'wet',
      filesScanned: files.length,
      totalLines,
      linesWithRedactions: totalRedactedLines,
      totalsByClass: totals,
      partitionsWritten: Array.from(outputByPartition.keys()).sort(),
    },
    null,
    2,
  ))
}

main().catch((err) => {
  console.error(`redact-traces failed: ${err}`)
  process.exit(1)
})
