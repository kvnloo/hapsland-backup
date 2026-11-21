import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { discoverPhysicalWorkingTreeRoot } from "@hapsland/native-observation/repository/root"
import type { PhysicalRootIdentity } from "@hapsland/native-observation/direct-event/observation"
import { decodeConfigurationDocument } from "@hapsland/runtime-inputs/configuration/decode"
import { configurationError } from "@hapsland/runtime-inputs/configuration/errors"
import type { LoadConfigurationOptions } from "@hapsland/runtime-inputs/configuration/load"
import { resolveConfiguration } from "@hapsland/runtime-inputs/configuration/resolve"
import { compileRules, type CompiledRule } from "@hapsland/review-definition/rules/compiler"
import { loadRules } from "@hapsland/review-definition/rules/loader"
import { ruleOperation } from "@hapsland/review-definition/rules/operations"
import { decodeRuleText } from "@hapsland/review-definition/rules/schema"
import { loadReviewSettings } from "@hapsland/review-definition/runtime/review-config"
import { settingsSource, type ReviewSettingsSnapshot } from "@hapsland/review-definition/runtime/review-settings"
import { RuleChanges } from "./contract.ts"

const optionalText = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined)
const canonicalDestination = (path: string): string => {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(canonicalDestination(parent), path.slice(parent.length + 1))
}

export interface RuleChangesPlan {
  readonly version: 1
  readonly repository: string
  readonly rootIdentity: PhysicalRootIdentity
  readonly changes: RuleChanges
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly before: string | undefined
    readonly after: string
    readonly scope: "project"
    readonly id: string
    readonly action: "create"
  }>
  readonly configurations: ReadonlyArray<{
    readonly path: string
    readonly before: string | undefined
    readonly after: string
    readonly scope: "project"
  }>
  readonly snapshots: ReadonlyArray<{ readonly path: string; readonly text: string | undefined }>
  readonly rules: ReadonlyArray<CompiledRule>
  readonly settings: ReviewSettingsSnapshot
  readonly previewDigest: string
}

/** Read-only plan; mutation owners recompute this same operation under their existing lock. */
export const previewRuleChanges = Effect.fn("Rules.previewExactChanges")(function* (
  root: string,
  suppliedChanges: RuleChanges,
  options: LoadConfigurationOptions = {}
): Effect.fn.Return<RuleChangesPlan, Error> {
  const changes = yield* Schema.decodeUnknownEffect(RuleChanges, { onExcessProperty: "error" })(suppliedChanges)
  const repository = yield* discoverPhysicalWorkingTreeRoot(root)
  const source = settingsSource(repository.root, options.userConfigPath)
  const configurationOffset = yield* ruleOperation(source.projectConfiguration, "$", () =>
    relative(repository.root, canonicalDestination(source.projectConfiguration))
  )
  if (configurationOffset === ".." || configurationOffset.startsWith("../") || isAbsolute(configurationOffset))
    return yield* configurationError(
      source.projectConfiguration,
      "$",
      "project configuration must stay inside the Git working tree"
    )
  const current = yield* loadReviewSettings(repository.root, options)
  const configurationPath = source.projectConfiguration
  const layers = current.configuration.policy.layers
  const existing = yield* loadRules({ root: repository.root, layers })
  const project = layers.find((layer) => layer.name === "project")
  const document = project?.document ?? { version: 1 as const }
  const files = []
  const references = [...(document.rules ?? [])]
  const identities = new Set(existing.map((rule) => rule.id))
  for (const change of changes) {
    const decoded = yield* ruleOperation(change.path, "$", () => decodeRuleText(change.content, change.path))
    const expected = join(repository.root, ".hapsland", "rules", "custom", `${encodeURIComponent(decoded.id)}.jsonc`)
    const path = yield* ruleOperation(change.path, "path", () =>
      canonicalDestination(resolve(repository.root, change.path))
    )
    if (path !== expected || resolve(repository.root, change.path) !== expected)
      return yield* configurationError(change.path, "path", "creation must use the authorized Project rule destination")
    const before = yield* ruleOperation(path, "$", () => optionalText(path))
    if (before !== undefined || identities.has(decoded.id))
      return yield* configurationError(
        path,
        "id",
        "creation needs a new rule identity and an absent authorized destination"
      )
    identities.add(decoded.id)
    files.push({ path, before, after: change.content, scope: change.scope, id: decoded.id, action: change.action })
    references.push({ path: relative(dirname(configurationPath), path), ...change.settings })
  }
  const proposedDocument = yield* ruleOperation(configurationPath, "$", () =>
    decodeConfigurationDocument({ ...document, rules: references }, configurationPath)
  )
  const replacement = { name: "project" as const, source: configurationPath, document: proposedDocument }
  const proposedLayers =
    project === undefined
      ? [...layers, replacement]
      : layers.map((layer) => (layer.name === "project" ? replacement : layer))
  const policy = yield* ruleOperation(configurationPath, "$", () =>
    resolveConfiguration(proposedLayers, repository.root)
  )
  const loaded = yield* loadRules({
    root: repository.root,
    layers: policy.layers,
    overlays: files.map((file) => ({ path: file.path, content: file.after }))
  })
  const rules = yield* ruleOperation(configurationPath, "rules", () =>
    compileRules({ rules: loaded, includeDisabled: true })
  )
  const settings: ReviewSettingsSnapshot = {
    ...current,
    source,
    configuration: { policy },
    rules: rules.filter((rule) => rule.enabled),
    ruleDigests: loaded.map((rule) => `${rule.id}:${rule.definitionDigest}`)
  }
  const snapshots = yield* ruleOperation(configurationPath, "$", () =>
    [
      ...new Set([
        source.userConfiguration,
        configurationPath,
        ...layers.filter((layer) => layer.name !== "built-in").map((layer) => layer.source),
        ...existing.map((rule) => rule.path)
      ])
    ].map((path) => ({ path, text: optionalText(path) }))
  )
  const configurations = [
    {
      path: configurationPath,
      scope: "project" as const,
      before: snapshots.find((snapshot) => snapshot.path === configurationPath)?.text,
      after: JSON.stringify(proposedDocument, null, 2) + "\n"
    }
  ]
  const bound = {
    version: 1 as const,
    repository: repository.root,
    rootIdentity: repository.rootIdentity,
    changes,
    files,
    configurations,
    snapshots,
    effective: settings
  }
  return { ...bound, rules, settings, previewDigest: createHash("sha256").update(JSON.stringify(bound)).digest("hex") }
})
