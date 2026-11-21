import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

/** Resolves existing ancestors of a proposed rule or configuration path without writing. */
export const canonicalDestination = (path: string): string => {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(canonicalDestination(parent), path.slice(parent.length + (parent.endsWith("/") ? 0 : 1)))
}
