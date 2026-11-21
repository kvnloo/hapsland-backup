import { canonicalDestination } from "../canonical-destination.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { discoverPhysicalWorkingTreeRoot } from "@hapsland/native-observation/repository/root"
import type { PhysicalRootIdentity } from "@hapsland/native-observation/direct-event/observation"
import { decodeConfigurationDocument } from "@hapsland/runtime-inputs/configuration/decode"
import { configurationError } from "@hapsland/runtime-inputs/configuration/errors"
import type { LoadConfigurationOptions } from "@hapsland/runtime-inputs/configuration/load"
import { resolveConfiguration, type ConfigurationLayer } from "@hapsland/runtime-inputs/configuration/resolve"
import type { ConfigurationDocument, RuleReference, RuleSettings } from "@hapsland/runtime-inputs/configuration/types"
import { compileRules, type CompiledRule } from "@hapsland/review-definition/rules/compiler"
import { loadRules } from "@hapsland/review-definition/rules/loader"
import { ruleOperation } from "@hapsland/review-definition/rules/operations"
import { decodeRuleText } from "@hapsland/review-definition/rules/schema"
import { loadReviewSettings } from "@hapsland/review-definition/runtime/review-config"
import { settingsSource, type ReviewSettingsSnapshot } from "@hapsland/review-definition/runtime/review-settings"
import { RuleChanges, type RuleScope } from "./contract.ts"

const optionalText = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined)
export interface RuleChangesPlan {
  readonly version: 1
  readonly repository: string
  readonly rootIdentity: PhysicalRootIdentity
  readonly changes: RuleChanges
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly before: string | undefined
    readonly after: string
    readonly scope: RuleScope
    readonly id: string
    readonly action: "create" | "replace"
  }>
  readonly configurations: ReadonlyArray<{
    readonly path: string
    readonly before: string | undefined
    readonly after: string
    readonly scope: RuleScope
  }>
  readonly snapshots: ReadonlyArray<{ readonly path: string; readonly text: string | undefined }>
  readonly rules: ReadonlyArray<CompiledRule>
  readonly affectedRules: ReadonlyArray<{
    readonly id: string
    readonly before: CompiledRule | undefined
    readonly after: CompiledRule | undefined
  }>
  readonly settings: ReviewSettingsSnapshot
  readonly previewDigest: string
}

type ConfigurationEdit = {
  readonly path: string
  readonly scope: RuleScope
  readonly before: string | undefined
  document: ConfigurationDocument
}
const referencePath = (reference: RuleReference): string | undefined =>
  typeof reference === "string" ? reference : "path" in reference ? reference.path : undefined
const selectsIdentity = (reference: RuleReference, configurationPath: string, id: string, path: string): boolean => {
  if (typeof reference !== "string" && "id" in reference) return reference.id === id
  const selected = referencePath(reference)
  return selected !== undefined && canonicalDestination(resolve(dirname(configurationPath), selected)) === path
}
const updateReference = (edit: ConfigurationEdit, id: string, path: string, settings: RuleSettings) => {
  const references = edit.document.rules ?? []
  const index = references.findIndex((reference) => selectsIdentity(reference, edit.path, id, path))
  const next =
    index < 0
      ? [...references, { id, ...settings }]
      : references.map((reference, offset) =>
          offset !== index
            ? reference
            : { ...(typeof reference === "string" ? { path: reference } : reference), ...settings }
        )
  edit.document = decodeConfigurationDocument({ ...edit.document, rules: next }, edit.path)
}
const authoredLayer = (layers: ReadonlyArray<ConfigurationLayer>, path: string) =>
  layers.find((layer) =>
    (layer.document.rules ?? []).some((reference) => {
      const selected = referencePath(reference)
      return selected !== undefined && canonicalDestination(resolve(dirname(resolve(layer.source)), selected)) === path
    })
  )?.name

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
  const current = yield* loadReviewSettings(repository.root, {
    userConfigPath: source.userConfiguration,
    projectConfigPath: source.projectConfiguration
  })
  const configurationPath = source.projectConfiguration
  const layers = current.configuration.policy.layers
  const existing = yield* loadRules({ root: repository.root, layers })
  const files: Array<RuleChangesPlan["files"][number]> = []
  const identities = new Map(existing.map((rule) => [rule.id, rule.path]))
  const contentChanges = new Set<string>()
  const affected = new Set<string>()
  const edits = new Map<RuleScope, ConfigurationEdit>()
  for (const change of changes) {
    const edit = yield* ruleOperation(configurationPath, "rules", () => {
      const previous = edits.get(change.scope)
      if (previous !== undefined) return previous
      const path = change.scope === "project" ? source.projectConfiguration : source.userConfiguration
      const layer = layers.find((layer) => layer.name === (change.scope === "project" ? "project" : "user"))
      const next = {
        path,
        scope: change.scope,
        before: optionalText(path),
        document: layer?.document ?? { version: 1 as const }
      }
      edits.set(change.scope, next)
      return next
    })
    if (change.action === "configure") {
      const selectedPath = identities.get(change.id)
      if (selectedPath === undefined)
        return yield* configurationError(
          edit.path,
          "id",
          "configure must name an existing or earlier proposed rule identity"
        )
      yield* ruleOperation(edit.path, "rules", () => updateReference(edit, change.id, selectedPath, change.settings))
      affected.add(change.id)
      continue
    }
    const decoded = yield* ruleOperation(change.path, "$", () => decodeRuleText(change.content, change.path))
    const path = yield* ruleOperation(change.path, "path", () =>
      canonicalDestination(resolve(repository.root, change.path))
    )
    let before: string | undefined
    if (contentChanges.has(decoded.id))
      return yield* configurationError(path, "id", "each rule can have only one complete content change in a proposal")
    if (change.action === "create") {
      const expected = join(
        change.scope === "project" ? join(repository.root, ".hapsland") : dirname(source.userConfiguration),
        "rules",
        "custom",
        `${encodeURIComponent(decoded.id)}.jsonc`
      )
      const authorized = yield* ruleOperation(expected, "path", () => canonicalDestination(expected))
      if (
        resolve(repository.root, change.path) !== expected ||
        path !== authorized ||
        (change.scope === "project" && authorized !== expected)
      )
        return yield* configurationError(
          change.path,
          "path",
          `creation must use the authorized ${change.scope === "project" ? "Project" : "Personal"} rule destination`
        )
      const entry = yield* ruleOperation(path, "$", () => lstatSync(path, { throwIfNoEntry: false }))
      if (entry !== undefined || identities.has(decoded.id))
        return yield* configurationError(
          path,
          "id",
          "creation needs a new rule identity and an absent authorized destination"
        )
      identities.set(decoded.id, path)
      edit.document = {
        ...edit.document,
        rules: [...(edit.document.rules ?? []), { path: relative(dirname(edit.path), path), ...change.settings }]
      }
    } else {
      const selected = existing.find((rule) => rule.id === change.id)
      if (selected === undefined || decoded.id !== change.id || selected.path !== path)
        return yield* configurationError(
          change.path,
          "id",
          "replacement destination and complete content must match the named existing authored rule"
        )
      const owner = yield* ruleOperation(path, "scope", () => authoredLayer(layers, path))
      if (owner !== (change.scope === "personal" ? "user" : "project"))
        return yield* configurationError(
          path,
          "scope",
          "replacement scope must match the existing authored file owner; use a distinct Project identity for a Personal alternative"
        )
      before = yield* ruleOperation(path, "$", () => optionalText(path))
      if (before === undefined)
        return yield* configurationError(path, "$", "replacement requires an existing authored file")
      yield* ruleOperation(edit.path, "rules", () => updateReference(edit, decoded.id, path, change.settings))
    }
    contentChanges.add(decoded.id)
    affected.add(decoded.id)
    files.push({ path, before, after: change.content, scope: change.scope, id: decoded.id, action: change.action })
  }
  const replacements = [...edits.values()].map((edit) => ({
    name: edit.scope === "personal" ? ("user" as const) : ("project" as const),
    source: edit.path,
    document: edit.document
  }))
  const proposedLayers = [
    ...layers.filter((layer) => !replacements.some((replacement) => replacement.name === layer.name)),
    ...replacements
  ]
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
  const configurations = [...edits.values()].map((edit) => ({
    path: edit.path,
    scope: edit.scope,
    before: edit.before,
    after: JSON.stringify(edit.document, null, 2) + "\n"
  }))
  const beforeRules = yield* ruleOperation(repository.root, "rules", () =>
    compileRules({ rules: existing, includeDisabled: true })
  )
  const affectedRules = [...affected].map((id) => ({
    id,
    before: beforeRules.find((rule) => rule.id === id),
    after: rules.find((rule) => rule.id === id)
  }))
  const bound = {
    version: 1 as const,
    repository: repository.root,
    rootIdentity: repository.rootIdentity,
    changes,
    files,
    configurations,
    snapshots,
    affectedRules,
    effective: settings
  }
  return { ...bound, rules, settings, previewDigest: createHash("sha256").update(JSON.stringify(bound)).digest("hex") }
})
