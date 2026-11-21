import { recoveryPlan } from "./plan.ts"
import { validateCurrentRecoveryHooks } from "./hooks.ts"
import { type Journal } from "../journal.ts"
import { decodeOwnershipContent, type OwnershipRecord } from "../ownership.ts"
import { type buildInputs } from "../runtime-inputs.ts"
import { snapshot, mutationBeforeFile, type Mutation } from "../file-snapshots.ts"
import { desiredMcp, expectedEntry, withMcpEntry, mcpEntry, assertSkillPath } from "../mcp.ts"
import { makeOwnershipRecord } from "../target-ownership.ts"
import { resolveIntegrationSelection } from "../../integration-selection.ts"
import { canonicalJson } from "../../hook-reconciliation.ts"
import { encodeJson, parseJsonObject, isObject } from "../configuration-values.ts"
import {
  enableHooksFeature,
  disableOwnedFeature,
  validateToml,
  validateOwnedHooksFeatureRemoval
} from "../hooks-feature.ts"
import {
  ownedGroup,
  composedGroups,
  withComposedGroups,
  addOwnedHook,
  replaceOwnedHook,
  removeOwnedHook,
  preserveHookFormatting,
  postToolUseGroups,
  isOwnedPostGroup
} from "../hooks.ts"
import { hookFingerprint } from "../hook-identity.ts"
import { bindingDigest } from "../../hook-binding.ts"

type Inputs = ReturnType<typeof buildInputs>
const same = (actual: unknown, expected: unknown, reason: string) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(reason)
}
const readRecord = (content: string | null | undefined) =>
  content == null ? undefined : decodeOwnershipContent(content)
const withoutMcp = (record: OwnershipRecord) => {
  const { mcp: _mcp, integrations: _integrations, ...rest } = record
  return rest
}
const hookState = (change: Mutation | undefined, inputs: Inputs) =>
  change?.afterContent === null
    ? {}
    : parseJsonObject(
        change === undefined
          ? snapshot(inputs.paths.hooks)
          : { ...snapshot(inputs.paths.hooks), content: change.afterContent ?? "", exists: true }
      )
const hasIndependentHooks = (root: Record<string, unknown>) =>
  isObject(root.hooks) && Object.values(root.hooks).some((value) => Array.isArray(value) && value.length > 0)

/** Validate exact expanded plans before the existing journal resumes any write. */
export const validateMcpRecovery = (journal: Journal, inputs: Inputs): boolean => {
  const ownerChange = journal.mutations.find((change) => change.path === inputs.paths.ownership)
  const before = readRecord(ownerChange?.beforeContent)
  const after = readRecord(ownerChange?.afterContent)
  if (
    before?.integrations === undefined &&
    after?.integrations === undefined &&
    before?.mcp === undefined &&
    after?.mcp === undefined
  ) {
    if (journal.mutations.some((change) => change.path === inputs.paths.skill))
      throw new Error("recovery journal cannot write a companion skill without MCP ownership")
    return false
  }
  if (ownerChange === undefined) throw new Error("MCP recovery plan must bind its owned installation record")
  const selection = resolveIntegrationSelection(undefined, after?.integrations ?? before?.integrations)
  const selectedInputs = { ...inputs, integrations: selection }
  const removing = journal.operation === "uninstall"
  const targetHooks = !removing && selection.hooks
  const targetMcp = !removing && selection.mcp
  const desired = targetMcp ? desiredMcp(selectedInputs) : undefined
  if (before !== undefined && before.codexHome !== inputs.home)
    throw new Error("MCP recovery ownership targets another profile")
  const configChange = journal.mutations.find((change) => change.path === inputs.paths.config)
  const hooksChange = journal.mutations.find((change) => change.path === inputs.paths.hooks)
  const skillChange = journal.mutations.find((change) => change.path === inputs.paths.skill)
  const bindingChange = journal.mutations.find((change) => change.path === inputs.paths.binding)
  const configBefore = configChange === undefined ? snapshot(inputs.paths.config) : mutationBeforeFile(configChange)
  const featureOwnedBefore =
    before?.owned.some((entry) => entry.kind === "feature" && entry.file === inputs.paths.config) ?? false
  assertSkillPath(inputs)
  const parsedBefore = validateToml(configBefore)
  if (!targetHooks)
    validateOwnedHooksFeatureRemoval(
      before?.owned.find((entry) => entry.kind === "feature" && entry.file === inputs.paths.config),
      parsedBefore
    )
  const previousEntry = mcpEntry(parsedBefore)
  if (previousEntry !== undefined)
    same(
      previousEntry,
      before?.mcp === undefined ? null : expectedEntry(before.mcp),
      "MCP recovery cannot replace an unowned or modified server"
    )
  const featureOwned =
    targetHooks && (featureOwnedBefore || !(isObject(parsedBefore.features) && parsedBefore.features.hooks === true))
  let expectedConfig = configBefore.content
  if (targetHooks) expectedConfig = enableHooksFeature(configBefore)
  else if (featureOwnedBefore && !hasIndependentHooks(hookState(hooksChange, inputs)))
    expectedConfig = disableOwnedFeature(expectedConfig)
  const mcpConfig = { ...configBefore, exists: true, content: expectedConfig }
  expectedConfig = withMcpEntry(mcpConfig, desired === undefined ? undefined : expectedEntry(desired.ownership))
  same(
    configChange?.afterContent ?? configBefore.content,
    expectedConfig,
    "MCP recovery configuration changes unrelated settings"
  )
  if (skillChange !== undefined) {
    if (
      skillChange.beforeContent !== null &&
      (before?.mcp === undefined || bindingDigest(skillChange.beforeContent) !== before.mcp.skillDigest)
    )
      throw new Error("MCP recovery cannot replace an unowned or modified companion skill")
    same(
      skillChange.afterContent,
      desired?.skill ?? null,
      "MCP recovery skill does not match the selected retained package"
    )
  } else {
    const skill = snapshot(inputs.paths.skill)
    if (desired !== undefined)
      same(
        skill.exists ? skill.content : null,
        desired.skill,
        "MCP recovery no longer has its selected companion skill"
      )
    else if (before?.mcp !== undefined && skill.exists)
      throw new Error("MCP removal recovery does not bind the owned companion skill")
  }
  if (hooksChange !== undefined) {
    const hooksBefore = mutationBeforeFile(hooksChange)
    const root = parseJsonObject(hooksBefore)
    let expected: Record<string, unknown>
    if (targetHooks) {
      const group = ownedGroup(
        inputs.executable,
        inputs.entrypoint,
        inputs.codex.version,
        inputs.controlledReviewer,
        inputs.binding?.command
      )
      expected = withComposedGroups(
        postToolUseGroups(root).some(isOwnedPostGroup) ? replaceOwnedHook(root, group) : addOwnedHook(root, group),
        composedGroups(
          inputs.executable,
          inputs.entrypoint,
          inputs.codex.version,
          inputs.controlledReviewer,
          inputs.binding?.command
        ),
        before?.composedFingerprints,
        true,
        before?.hookGroups
      )
    } else {
      if (before === undefined) throw new Error("MCP-only recovery cannot change unowned hooks")
      expected = withComposedGroups(
        removeOwnedHook(root, before.hookFingerprint, before.hookGroups?.PostToolUse),
        undefined,
        before.composedFingerprints,
        true,
        before.hookGroups
      )
    }
    same(
      hooksChange.afterContent,
      targetHooks ? preserveHookFormatting(hooksBefore, expected) : encodeJson(expected),
      "MCP recovery hook changes do not preserve unrelated hooks"
    )
  }
  if (
    hooksChange === undefined &&
    !targetHooks &&
    resolveIntegrationSelection(undefined, before?.integrations).hooks &&
    before !== undefined &&
    postToolUseGroups(parseJsonObject(snapshot(inputs.paths.hooks))).some(isOwnedPostGroup)
  )
    throw new Error("MCP-only recovery must bind removal of its prior hooks")
  if (hooksChange === undefined && targetHooks)
    validateCurrentRecoveryHooks(
      selectedInputs,
      recoveryPlan(journal, selectedInputs),
      "MCP recovery no longer has its exact selected hooks"
    )
  if (targetHooks && bindingChange === undefined) {
    const retainedBinding = before?.owned.find((entry) => entry.kind === "hook" && entry.file === inputs.paths.binding)
    if (retainedBinding !== undefined) {
      const current = snapshot(inputs.paths.binding)
      if (!current.exists || bindingDigest(current.content) !== retainedBinding.fingerprint)
        throw new Error("retained hook launcher changed during MCP recovery")
    } else if (inputs.binding !== undefined && snapshot(inputs.paths.binding).content !== inputs.binding.content) {
      throw new Error("target hook launcher changed during MCP recovery")
    }
  }
  if (bindingChange !== undefined) {
    if (targetHooks)
      same(
        bindingChange.afterContent,
        inputs.binding?.content,
        "MCP recovery hook binding does not select the target package"
      )
    else {
      const owned = before?.owned.find((entry) => entry.file === inputs.paths.binding)
      if (
        owned === undefined ||
        bindingChange.beforeContent === null ||
        bindingDigest(bindingChange.beforeContent) !== owned.fingerprint ||
        bindingChange.afterContent !== null
      )
        throw new Error("MCP recovery cannot remove an unowned hook binding")
    }
  }
  if (removing) {
    if (ownerChange.afterContent !== null) throw new Error("MCP removal recovery must remove its record")
  } else {
    if (after === undefined) throw new Error("MCP recovery must record the selected integrations")
    const group = ownedGroup(
      inputs.executable,
      inputs.entrypoint,
      inputs.codex.version,
      inputs.controlledReviewer,
      inputs.binding?.command
    )
    const base = makeOwnershipRecord(selectedInputs, targetHooks ? hookFingerprint(group) : "", featureOwned)
    const { hookGroups: _groups, composedFingerprints: _composed, ...plain } = base
    const target = targetHooks ? base : { ...plain, owned: [] }
    const retained =
      targetHooks &&
      before !== undefined &&
      hooksChange === undefined &&
      bindingChange === undefined &&
      canonicalJson(withoutMcp(after)) === canonicalJson(withoutMcp(before))
    if (!retained)
      same(withoutMcp(after), target, "MCP recovery ownership does not match the selected retained package")
    same(after.integrations, selection, "MCP recovery selection changed")
    same(after.mcp ?? null, desired?.ownership ?? null, "MCP recovery executable or skill identity changed")
  }
  return true
}
