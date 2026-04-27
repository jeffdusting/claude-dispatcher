/**
 * MemoryProbe stub for workerRegistry tests. Mirrors the seam pattern A.9.6
 * introduced — the smoke test substitutes a probe that records sampled and
 * killed PIDs without invoking `ps` or sending real signals.
 */

import type { MemoryProbe } from '../../src/workerRegistry.js'

export interface FakeProbe extends MemoryProbe {
  rssByPid: Map<number, number | Error>
  killed: number[]
  sampled: number[]
}

export function makeFakeProbe(): FakeProbe {
  const sampled: number[] = []
  const killed: number[] = []
  const rssByPid: Map<number, number | Error> = new Map()
  return {
    rssByPid,
    sampled,
    killed,
    async sampleRss(pid: number): Promise<number> {
      sampled.push(pid)
      const v = rssByPid.get(pid)
      if (v instanceof Error) throw v
      return v ?? 0
    },
    kill(pid: number): void {
      killed.push(pid)
    },
  }
}
