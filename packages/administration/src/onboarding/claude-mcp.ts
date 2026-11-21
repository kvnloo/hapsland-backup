import { createHash } from "node:crypto"
import {
  commandFromEntrypoint,
  emittedReleaseEntrypoints,
  packageRootFromEntrypoint
} from "@hapsland/runtime-environment/runtime/package-runtime"
import { sourceRuntimeFromEntrypoint } from "@hapsland/runtime-environment/runtime/source-runtime-layout"
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { canonicalJson as canonical } from "./hook-reconciliation.ts"

export interface ClaudeMcpOwnership {
  readonly configuration: string
  readonly entry: unknown
  readonly skillDigest: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
export const claudeSkillDigest = (content: string): string => createHash("sha256").update(content).digest("hex")
export const validClaudeMcpOwnership = (value: unknown): boolean =>
  value === undefined ||
  (object(value) &&
    typeof value.configuration === "string" &&
    object(value.entry) &&
    typeof value.skillDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.skillDigest))

export const assertClaudeSkillDirectories = (home: string, skill: string): void => {
  for (let directory = dirname(skill); directory !== home; directory = dirname(directory)) {
    try {
      if (!lstatSync(directory).isDirectory())
        throw new Error("Claude skill directory is not an owned regular directory")
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error
    }
  }
}

const configurationObject = (content: string | undefined): Record<string, unknown> => {
  const parsed: unknown = content === undefined ? {} : JSON.parse(content)
  if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers)))
    throw new Error("Claude MCP configuration must contain an object with object mcpServers")
  return parsed
}

const selectedMcpAssets = (target: { readonly runtime: string; readonly entrypoint: string }) => {
  const root = packageRootFromEntrypoint(target.entrypoint)
  const materialized = sourceRuntimeFromEntrypoint(target.entrypoint)
  const cli =
    materialized !== undefined
      ? join(materialized.directory, "cli.mjs")
      : extname(target.entrypoint) === ""
        ? join(dirname(target.entrypoint), "hapsland")
        : join(root, emittedReleaseEntrypoints.cli)
  if (!statSync(cli).isFile()) throw new Error("Selected Claude MCP command is not a regular file")
  const command = commandFromEntrypoint(target.runtime, cli)
  if (command.args.length === 0) accessSync(command.executable, constants.X_OK)
  return {
    entry: { type: "stdio", command: command.executable, args: [...command.args, "mcp"], env: {} },
    skill: readFileSync(join(root, "skills", "hapsland-rule-authoring", "SKILL.md"), "utf8")
  }
}

/** Plans only the selected profile's MCP entry and canonical skill; caller owns lock and writes. */
export const planClaudeMcp = (request: {
  readonly enabled: boolean
  readonly configuration: string
  readonly beforeConfiguration: string | undefined
  readonly beforeSkill: string | undefined
  readonly owned: ClaudeMcpOwnership | undefined
  readonly target: { readonly runtime: string; readonly entrypoint: string }
}) => {
  const document = configurationObject(request.beforeConfiguration)
  const servers = object(document.mcpServers) ? document.mcpServers : {}
  const current = servers.hapsland
  if (request.owned !== undefined && request.owned.configuration !== request.configuration)
    throw new Error("Claude MCP ownership belongs to another profile configuration")
  if (current !== undefined && (request.owned === undefined || canonical(current) !== canonical(request.owned.entry)))
    throw new Error("Claude Hapsland MCP entry was locally modified or is not owned")
  if (
    request.beforeSkill !== undefined &&
    (request.owned === undefined || claudeSkillDigest(request.beforeSkill) !== request.owned.skillDigest)
  )
    throw new Error("Claude Hapsland skill was locally modified or is not owned")
  const desired = request.enabled ? selectedMcpAssets(request.target) : undefined
  let afterConfiguration = request.beforeConfiguration
  if (request.enabled || request.owned !== undefined) {
    const nextServers = { ...servers }
    if (desired !== undefined) nextServers.hapsland = desired.entry
    else delete nextServers.hapsland
    const next: Record<string, unknown> = { ...document, mcpServers: nextServers }
    if (Object.keys(nextServers).length === 0) delete next.mcpServers
    if (canonical(next) !== canonical(document)) afterConfiguration = `${JSON.stringify(next, null, 2)}\n`
  }
  return {
    installed: request.owned !== undefined && current !== undefined && request.beforeSkill !== undefined,
    afterConfiguration,
    afterSkill: desired !== undefined ? desired.skill : request.owned === undefined ? request.beforeSkill : undefined,
    ownership:
      desired !== undefined
        ? { configuration: request.configuration, entry: desired.entry, skillDigest: claudeSkillDigest(desired.skill) }
        : undefined,
    entry: desired?.entry
  }
}
