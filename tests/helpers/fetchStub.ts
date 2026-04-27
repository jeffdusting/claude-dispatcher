/**
 * Fetch interception helper for tests.
 *
 * Replaces globalThis.fetch with a recording stub. Each call is captured
 * (url + init) so assertions can inspect what was sent. The default
 * response is an empty 200; tests pass `respond` to vary by URL.
 *
 * Usage:
 *   const stub = installFetchStub({
 *     respond: (url) => url.includes('twilio') ? { status: 200, body: '{}' } : undefined,
 *   })
 *   ...exercise code...
 *   expect(stub.calls).toHaveLength(1)
 *   stub.uninstall()
 */

export interface FetchCall {
  url: string
  init?: RequestInit
}

export interface StubResponse {
  status?: number
  body?: string
  headers?: Record<string, string>
}

export interface FetchStub {
  calls: FetchCall[]
  uninstall: () => void
}

export interface InstallOptions {
  respond?: (url: string, init?: RequestInit) => StubResponse | undefined
}

export function installFetchStub(opts: InstallOptions = {}): FetchStub {
  const previous = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { toString(): string }).toString()
    calls.push({ url, init })
    const custom = opts.respond?.(url, init)
    const status = custom?.status ?? 200
    const body = custom?.body ?? ''
    const headers = custom?.headers ?? { 'content-type': 'application/json' }
    return new Response(body, { status, headers })
  }) as typeof globalThis.fetch

  return {
    calls,
    uninstall(): void {
      globalThis.fetch = previous
    },
  }
}
