import { createHash } from "node:crypto"
import { Schema } from "effect"
import { IntegrationSelection } from "./integration-selection.ts"
import { canonicalJson, object, removeMarkedHandlers } from "./hook-reconciliation.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export const ClaudeOwnedIdentity = Schema.Struct({
  version: Schema.Literal(1),
  adapter: Schema.Literal("claude"),
  home: Schema.String,
  hookDigest: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  integrations: Schema.optionalKey(IntegrationSelection),
  mcp: Schema.optionalKey(Schema.Struct({ configuration: Schema.String, entry: JsonObject, skillDigest: Hash })),
  implementation: Schema.optionalKey(Schema.Struct({ executable: Schema.String, args: Schema.Array(Schema.String) })),
  bindingDigest: Schema.optionalKey(Schema.String),
  hookGroups: Schema.optionalKey(JsonObject),
  composed: Schema.optionalKey(
    Schema.Struct({
      stopDigest: Schema.String,
      promptDigest: Schema.String,
      subagentStopDigest: Schema.optionalKey(Schema.String),
      preToolUseDigest: Schema.optionalKey(Schema.String)
    })
  )
})
export interface ClaudeOwnedIdentity extends Schema.Schema.Type<typeof ClaudeOwnedIdentity> {}
const Slot = Schema.Struct({ before: Hash, after: Hash })
export const ClaudePendingTransition = Schema.Struct({
  reinstall: Schema.Boolean,
  operation: Schema.Literals(["install", "update", "uninstall"]),
  approvedProposalDigest: Hash,
  home: Schema.String,
  target: Schema.NullOr(Schema.Struct({ runtime: Schema.String, entrypoint: Schema.String, assetIdentity: Hash })),
  before: Schema.NullOr(ClaudeOwnedIdentity),
  after: Schema.NullOr(ClaudeOwnedIdentity),
  slots: Schema.Struct({ mcpEntry: Slot, skill: Slot, binding: Slot, hooks: Schema.Record(Schema.String, Slot) }),
  surrounding: Schema.Struct({ settings: Hash, mcp: Hash })
})
export interface ClaudePendingTransition extends Schema.Schema.Type<typeof ClaudePendingTransition> {}
export const ClaudeOwnedRecord = Schema.Struct({
  ...ClaudeOwnedIdentity.fields,
  pending: Schema.optionalKey(ClaudePendingTransition)
})
export interface ClaudeOwnedRecord extends Schema.Schema.Type<typeof ClaudeOwnedRecord> {}

export const claudeTransitionHash = (value: unknown): string =>
  createHash("sha256")
    .update(value === undefined ? "<absent>" : canonicalJson(value))
    .digest("hex")
export const CLAUDE_OWNED_EVENTS = ["PostToolUse", "PreToolUse", "Stop", "SubagentStop", "UserPromptSubmit"] as const
export const CLAUDE_MARKERS = ["--review-tool-owned=claude-v1", "--review-tool-composed-owned=claude-v1"]
const HookConfiguration = Schema.Record(Schema.String, Schema.Array(Schema.Unknown))
export const claudeOwnedHooks = (settings: Record<string, unknown>, event: string): readonly unknown[] => {
  if (settings.hooks === undefined) return []
  const groups = Schema.decodeUnknownSync(HookConfiguration)(settings.hooks)[event]
  if (groups === undefined) return []
  if (!Array.isArray(groups)) throw new Error(`Claude ${event} hooks must be an array`)
  return groups.flatMap((group) => {
    if (!object(group) || !Array.isArray(group.hooks)) return []
    const hooks = group.hooks.filter((handler) => {
      const command = object(handler) ? handler.command : undefined
      return typeof command === "string" && CLAUDE_MARKERS.some((marker) => command.includes(marker))
    })
    return hooks.length === 0 ? [] : [{ ...group, hooks }]
  })
}
export const claudeUnownedSettings = (settings: Record<string, unknown>) =>
  removeMarkedHandlers(settings, CLAUDE_MARKERS)
export const claudeMcpProjection = (document: Record<string, unknown>) => {
  if (document.mcpServers !== undefined && !object(document.mcpServers))
    throw new Error("Claude mcpServers must be an object")
  const servers = object(document.mcpServers) ? { ...document.mcpServers } : {}
  const entry = servers.hapsland
  delete servers.hapsland
  const unowned = { ...document }
  if (Object.keys(servers).length === 0) delete unowned.mcpServers
  else unowned.mcpServers = servers
  return { entry, unowned }
}
export const assertClaudeTransitionSlot = (
  name: string,
  value: unknown,
  slot: { readonly before: string; readonly after: string }
): void => {
  const hash = claudeTransitionHash(value)
  if (hash !== slot.before && hash !== slot.after)
    throw new Error(`Pending Claude ${name} was locally modified; no recovery writes were performed`)
}
