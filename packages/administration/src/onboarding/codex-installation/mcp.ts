import { sourceRuntimeFromEntrypoint } from "@hapsland/runtime-environment/runtime/source-runtime-layout"
import { lstatSync, readFileSync, statSync, accessSync, constants } from "node:fs"
import { dirname, extname, join, relative } from "node:path"
import { stringify as stringifyToml, parse as parseToml } from "smol-toml"
import {
  commandFromEntrypoint,
  emittedReleaseEntrypoints,
  packageRootFromEntrypoint
} from "@hapsland/runtime-environment/runtime/package-runtime"
import { canonicalJson } from "../hook-reconciliation.ts"
import { resolveIntegrationSelection } from "../integration-selection.ts"
import { type OwnershipRecord, readOwnership, decodeOwnershipContent, type McpOwnership } from "./ownership.ts"
import { snapshot, mutation, sha256, type Mutation, type FileSnapshot } from "./file-snapshots.ts"
import { validateToml, tomlLines, disableOwnedFeature, validateOwnedHooksFeatureRemoval } from "./hooks-feature.ts"
import { isObject, encodeJson, parseJsonObject } from "./configuration-values.ts"
import { withComposedGroups, removeOwnedHook } from "./hooks.ts"
import { makeOwnershipRecord } from "./target-ownership.ts"
import { type buildInputs } from "./runtime-inputs.ts"
import { type InstallationRequest } from "./request.ts"
import { installationDigest, reinstallDigest } from "./proposal.ts"

type Inputs = ReturnType<typeof buildInputs>
export const cliCommand = (inputs: Inputs) => {
  const root = packageRootFromEntrypoint(inputs.entrypoint)
  const source = sourceRuntimeFromEntrypoint(inputs.entrypoint)
  const cli =
    source !== undefined
      ? join(source.directory, "cli.mjs")
      : extname(inputs.entrypoint) === ""
        ? join(dirname(inputs.entrypoint), "hapsland")
        : join(root, emittedReleaseEntrypoints.cli)
  const command = commandFromEntrypoint(inputs.executable, cli)
  if (!statSync(cli).isFile()) throw new Error("packaged MCP CLI is not a regular file")
  accessSync(cli, constants.R_OK | (extname(cli) === "" ? constants.X_OK : 0))
  return { command: command.executable, args: [...command.args, "mcp"], env_vars: ["REVIEW_USER_CONFIG_PATH"] }
}
export const desiredMcp = (inputs: Inputs): { ownership: McpOwnership; skill: string } => {
  const skill = readFileSync(
    join(packageRootFromEntrypoint(inputs.entrypoint), "skills/hapsland-rule-authoring/SKILL.md"),
    "utf8"
  )
  return { ownership: { ...cliCommand(inputs), skillDigest: sha256(skill) }, skill }
}
export const assertSkillPath = (inputs: Inputs): void => {
  let current = inputs.paths.skill
  while (relative(inputs.home, current) !== "") {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("owned companion skill path is a symlink; preserve and reconcile it")
    } catch (cause) {
      if (!(isObject(cause) && cause.code === "ENOENT")) throw cause
    }
    current = dirname(current)
  }
}
export const mcpEntry = (document: Record<string, unknown>): unknown => {
  if (document.mcp_servers === undefined) return undefined
  if (!isObject(document.mcp_servers)) throw new Error("Codex mcp_servers must be a table")
  return document.mcp_servers.hapsland
}
export const expectedEntry = (record: McpOwnership) => ({
  command: record.command,
  args: record.args,
  env_vars: record.env_vars
})
export const inspectMcp = (inputs: Inputs, record: OwnershipRecord, allowMissing = false): void => {
  const actual = mcpEntry(validateToml(snapshot(inputs.paths.config)))
  if (record.mcp === undefined) {
    if (actual !== undefined) throw new Error("Hapsland MCP server name is already configured without ownership")
    return
  }
  if (actual === undefined ? !allowMissing : canonicalJson(actual) !== canonicalJson(expectedEntry(record.mcp)))
    throw new Error("owned Hapsland MCP registration is missing or locally modified")
  assertSkillPath(inputs)
  const skill = snapshot(inputs.paths.skill)
  if (skill.exists ? sha256(skill.content) !== record.mcp.skillDigest : !allowMissing)
    throw new Error("owned companion skill is missing or locally modified")
}

/** Replace only the owned table; unrelated TOML bytes stay intact. */
export const withMcpEntry = (
  file: FileSnapshot,
  entry: Pick<McpOwnership, "command" | "args" | "env_vars"> | undefined
): string => {
  const parsed = validateToml(file)
  const prior = mcpEntry(parsed)
  let start: number | undefined
  let end = file.content.length
  for (const line of tomlLines(file.content)) {
    if (!line.syntactic || !line.text.trimStart().startsWith("[")) continue
    let owned = false
    try {
      const probe = parseToml(`${line.text}\n__hapsland_probe__ = true\n`)
      owned =
        isObject(probe.mcp_servers) &&
        isObject(probe.mcp_servers.hapsland) &&
        probe.mcp_servers.hapsland.__hapsland_probe__ === true
    } catch {
      /* A syntactic table that cannot host this probe is another table. */
    }
    if (owned) {
      if (start !== undefined) throw new Error("duplicate Hapsland MCP tables")
      start = line.start
    } else if (start !== undefined && end === file.content.length) end = line.start
  }
  if (prior !== undefined && start === undefined)
    throw new Error("Hapsland MCP uses an unsupported TOML representation; preserve and reconcile it")
  const encoded = entry === undefined ? "" : stringifyToml({ mcp_servers: { hapsland: entry } })
  const after =
    start === undefined
      ? entry === undefined
        ? file.content
        : `${file.content}${file.content.length > 0 && !file.content.endsWith("\n") ? "\n" : ""}${encoded}`
      : `${file.content.slice(0, start)}${encoded}${file.content.slice(end)}`
  const observed = mcpEntry(validateToml({ ...file, exists: true, content: after }))
  if (canonicalJson(observed ?? null) !== canonicalJson(entry ?? null))
    throw new Error("Hapsland MCP table update could not preserve TOML authority")
  return after
}

const mcpChanges = (inputs: Inputs, record: OwnershipRecord | undefined, config: FileSnapshot, remove: boolean) => {
  if (record !== undefined) inspectMcp(inputs, record, true)
  else if (mcpEntry(validateToml(config)) !== undefined)
    throw new Error("Hapsland MCP server name is already configured without ownership")
  assertSkillPath(inputs)
  const skill = snapshot(inputs.paths.skill)
  if (record?.mcp === undefined && skill.exists) throw new Error("companion skill already exists without ownership")
  const desired = remove ? undefined : desiredMcp(inputs)
  const after = withMcpEntry(config, desired === undefined ? undefined : expectedEntry(desired.ownership))
  const mutations = [
    ...(after === config.content
      ? []
      : [
          mutation(
            config,
            after,
            remove
              ? "remove only the owned Hapsland MCP registration"
              : "register the retained Hapsland stdio MCP server"
          )
        ]),
    ...(desired === undefined
      ? skill.exists
        ? [mutation(skill, null, "remove the owned companion skill")]
        : []
      : skill.exists && skill.content === desired.skill
        ? []
        : [mutation(skill, desired.skill, "install the canonical Hapsland companion skill")])
  ]
  return { mutations, mcp: desired?.ownership }
}

/** Add MCP resources to the existing hook plan and keep one lock/journal/record owner. */
export const extendMcpPlan = (
  inputs: Inputs,
  mutations: ReadonlyArray<Mutation>,
  operation: "install" | "update" | "uninstall"
) => {
  const record = readOwnership(inputs.paths.ownership)
  if (!inputs.integrations.mcp && record?.mcp === undefined) return [...mutations]
  const configChange = mutations.find((change) => change.path === inputs.paths.config)
  const originalConfig = snapshot(inputs.paths.config)
  const baseConfig =
    configChange === undefined
      ? originalConfig
      : { ...originalConfig, exists: configChange.afterContent !== null, content: configChange.afterContent ?? "" }
  const selected = mcpChanges(inputs, record, baseConfig, operation === "uninstall" || !inputs.integrations.mcp)
  const changedConfig = selected.mutations.find((change) => change.path === inputs.paths.config)
  const all = mutations.filter(
    (change) => change.path !== inputs.paths.config && change.path !== inputs.paths.ownership
  )
  const nextConfig = changedConfig?.afterContent ?? configChange?.afterContent
  const configMutation =
    nextConfig === undefined || nextConfig === originalConfig.content
      ? []
      : [mutation(originalConfig, nextConfig, "update owned Codex integration configuration")]
  const owned = snapshot(inputs.paths.ownership)
  const priorOwnedMutation = mutations.find((change) => change.path === inputs.paths.ownership)
  const target =
    priorOwnedMutation?.afterContent === null
      ? undefined
      : priorOwnedMutation?.afterContent === undefined
        ? record
        : decodeOwnershipContent(priorOwnedMutation.afterContent)
  const nextOwned =
    operation === "uninstall"
      ? null
      : encodeJson({
          ...target,
          integrations: inputs.integrations,
          ...(selected.mcp === undefined ? {} : { mcp: selected.mcp })
        })
  if (operation !== "uninstall" && selected.mcp === undefined && isObject(target)) {
    const { mcp: _removed, ...rest } = target
    return [
      ...all,
      ...configMutation,
      ...selected.mutations.filter((change) => change.path !== inputs.paths.config),
      ...ownedMutation(owned, encodeJson({ ...rest, integrations: inputs.integrations }), operation)
    ]
  }
  return [
    ...all,
    ...configMutation,
    ...selected.mutations.filter((change) => change.path !== inputs.paths.config),
    ...ownedMutation(owned, nextOwned, operation)
  ]
}
const ownedMutation = (owned: FileSnapshot, next: string | null, operation: string) =>
  next === (owned.exists ? owned.content : null)
    ? []
    : [
        mutation(
          owned,
          next,
          operation === "uninstall" ? "remove the versioned ownership record" : "record selected Codex integrations"
        )
      ]

export const mcpOnlyPlan = (
  request: InstallationRequest,
  inputs: Inputs,
  operation: "install" | "update" | "uninstall"
) => {
  const record = readOwnership(inputs.paths.ownership)
  if (record !== undefined && record.codexHome !== inputs.home)
    throw new Error("ownership record targets another Codex home")
  if (operation === "update" && record === undefined)
    throw new Error("no owned Codex installation exists; run install first")
  if (operation === "uninstall" && record === undefined)
    return {
      inputs,
      record: makeOwnershipRecord(inputs, "", false),
      mutations: [],
      resetJournal: undefined,
      digest: installationDigest(operation, inputs.home, []),
      alreadyInstalled: false,
      alreadyCurrent: false,
      alreadyRemoved: true
    }
  const mutations: Mutation[] = []
  if (resolveIntegrationSelection(undefined, record?.integrations).hooks && record !== undefined) {
    const hooks = snapshot(inputs.paths.hooks)
    const root = withComposedGroups(
      removeOwnedHook(parseJsonObject(hooks), record.hookFingerprint, record.hookGroups?.PostToolUse),
      undefined,
      record.composedFingerprints,
      true,
      record.hookGroups
    )
    const next = encodeJson(root)
    if (next !== hooks.content) mutations.push(mutation(hooks, next, "remove only the owned PostToolUse adapter hook"))
    const config = snapshot(inputs.paths.config)
    const ownedFeature = validateOwnedHooksFeatureRemoval(
      record.owned.find((entry) => entry.kind === "feature" && entry.file === config.path),
      validateToml(config)
    )
    const independent =
      isObject(root.hooks) && Object.values(root.hooks).some((value) => Array.isArray(value) && value.length > 0)
    if (!independent && ownedFeature)
      mutations.push(
        mutation(config, disableOwnedFeature(config.content), "remove the owned Codex hooks feature entry")
      )
    const binding = snapshot(inputs.paths.binding)
    const ownedBinding = record.owned.find((entry) => entry.file === binding.path)
    if (ownedBinding !== undefined && binding.exists) {
      if (sha256(binding.content) !== ownedBinding.fingerprint)
        throw new Error("owned hook launcher was locally modified")
      mutations.push(mutation(binding, null, "remove the owned hook launcher"))
    }
  }
  const ownership = snapshot(inputs.paths.ownership)
  const base = makeOwnershipRecord(inputs, "", false)
  const { hookGroups: _groups, composedFingerprints: _composed, ...plain } = base
  mutations.push(
    mutation(
      ownership,
      operation === "uninstall" ? null : encodeJson({ ...plain, owned: [], integrations: inputs.integrations }),
      "record selected Codex integrations"
    )
  )
  const selected = extendMcpPlan(inputs, mutations, operation)
  const resetJournal = request.reinstall ? snapshot(inputs.paths.journal) : undefined
  const digest = reinstallDigest(
    installationDigest(operation, inputs.home, selected),
    resetJournal?.exists ? resetJournal.digest : undefined
  )
  return {
    inputs,
    record: record ?? base,
    mutations: selected,
    resetJournal,
    digest,
    alreadyInstalled: selected.length === 0,
    alreadyCurrent: selected.length === 0,
    alreadyRemoved: selected.length === 0
  }
}
