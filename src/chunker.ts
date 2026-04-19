/**
 * Discord message chunker — splits long responses into <=2000 char messages.
 * Splits at natural boundaries (double newlines, then single newlines, then spaces).
 */

const DISCORD_MAX = 2000

export function chunk(text: string): string[] {
  if (text.length <= DISCORD_MAX) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX) {
      chunks.push(remaining)
      break
    }

    // Try to split at a natural boundary within the limit
    let splitAt = -1

    // Prefer double newline (paragraph break)
    const doubleNl = remaining.lastIndexOf('\n\n', DISCORD_MAX)
    if (doubleNl > DISCORD_MAX * 0.3) {
      splitAt = doubleNl + 2
    }

    // Fall back to single newline
    if (splitAt === -1) {
      const singleNl = remaining.lastIndexOf('\n', DISCORD_MAX)
      if (singleNl > DISCORD_MAX * 0.3) {
        splitAt = singleNl + 1
      }
    }

    // Fall back to space
    if (splitAt === -1) {
      const space = remaining.lastIndexOf(' ', DISCORD_MAX)
      if (space > DISCORD_MAX * 0.3) {
        splitAt = space + 1
      }
    }

    // Hard split as last resort
    if (splitAt === -1) {
      splitAt = DISCORD_MAX
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  return chunks
}
