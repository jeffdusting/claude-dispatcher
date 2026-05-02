/**
 * Government-domain detection across jurisdictions.
 *
 * Examples that match: transport.nsw.gov.au, health.gov.au, gov.uk, state.gov,
 * foreign.gov.sg, mot.govt.nz.
 *
 * Examples that do not: government.com (commercial), sydney.org.au (advocacy),
 * committee-for-sydney.com.
 *
 * Anchored on word boundaries so it does not match e.g. "government.com".
 */

const GOVT_DOMAIN_REGEX = /(^|\.)gov(\.[a-z]{2,4})?$/i

export function isGovernmentDomain(domain: string): boolean {
  const d = (domain || '').toLowerCase().trim()
  if (!d) return false
  if (GOVT_DOMAIN_REGEX.test(d)) return true
  // NZ exception: uses .govt.nz rather than .gov.nz.
  if (d.endsWith('.govt.nz') || d === 'govt.nz') return true
  return false
}

/** Extract the domain portion of an RFC-822 From header. */
export function senderDomain(fromHeader: string): string {
  const match = /<([^>]+)>/.exec(fromHeader || '')
  const email = (match ? match[1] : fromHeader || '').trim().toLowerCase()
  if (email.includes('@')) return email.split('@', 2)[1]
  return ''
}
