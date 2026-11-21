import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { isAbsolute, posix } from "node:path"
import { readFileSync } from "node:fs"
import { discoverPhysicalWorkingTreeRoot } from "@hapsland/native-observation/repository/root"
import { localFailureMessage } from "../../invocation/failure-message.ts"
import { loadRuleInventory } from "../inventory.ts"
import { checkRuleAtLine, type EffectiveRuleCandidate } from "../check.ts"
import { RuleChanges } from "../authoring/contract.ts"
import { previewRuleChanges } from "../authoring/plan.ts"

export const MAX_CHECK_TARGETS = 20
export const Repository = Schema.NonEmptyString.check(Schema.isPattern(/^\//))
const RelativePath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      !isAbsolute(path) &&
      !path.includes("\0") &&
      posix.normalize(path) !== ".." &&
      !posix.normalize(path).startsWith("../")
  )
)
export const CheckTarget = Schema.Struct({ path: RelativePath, line: Schema.Int.check(Schema.isGreaterThan(0)) })
export const InspectRequest = Schema.Struct({
  repository: Repository,
  operation: Schema.Literal("inspect"),
  id: Schema.optional(Schema.NonEmptyString)
})
export const StoredCheckRequest = Schema.Struct({
  repository: Repository,
  mode: Schema.Literal("stored"),
  targets: Schema.Array(CheckTarget).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHECK_TARGETS)),
  ids: Schema.optional(Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(100)))
})
export type InspectRequest = typeof InspectRequest.Type
export type StoredCheckRequest = typeof StoredCheckRequest.Type
export const PreviewRequest = Schema.Struct({
  repository: Repository,
  operation: Schema.Literal("preview"),
  changes: RuleChanges
})
export type PreviewRequest = typeof PreviewRequest.Type
export const CandidateCheckRequest = Schema.Struct({
  repository: Repository,
  mode: Schema.Literal("candidate"),
  targets: Schema.Array(CheckTarget).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHECK_TARGETS)),
  changes: RuleChanges,
  previewDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
})
/** MCP requires type:object at the root; retain the complete discriminated union beneath it. */
const objectRoot = Schema.makeFilter<object>((value) => typeof value === "object" && value !== null, {
  toJsonSchema: () => ({ type: "object" })
})
export const DeriveRuleRequest = Schema.Union([InspectRequest, PreviewRequest]).check(objectRoot)
export const CheckRulesRequest = Schema.Union([StoredCheckRequest, CandidateCheckRequest]).check(objectRoot)
export type CheckRulesRequest = typeof CheckRulesRequest.Type

export const previewRules = Effect.fn("Rules.mcp.preview")(function* (request: PreviewRequest) {
  const userConfigPath = Option.getOrUndefined(yield* Config.option(Config.NonEmptyString("REVIEW_USER_CONFIG_PATH")))
  const plan = yield* previewRuleChanges(
    request.repository,
    request.changes,
    userConfigPath === undefined ? {} : { userConfigPath }
  )
  return {
    version: plan.version,
    repository: plan.repository,
    changes: plan.changes,
    files: plan.files,
    configurations: plan.configurations,
    previewDigest: plan.previewDigest,
    classifierCalls: 0,
    rules: plan.rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      threshold: rule.threshold,
      applicability: rule.applicability,
      languages: rule.languages,
      inputs: rule.inputs
    }))
  }
})

export const resolveRepository = Effect.fn("Rules.mcp.resolveRepository")(function* (repository: string) {
  if (!isAbsolute(repository)) return yield* Effect.fail(new Error("repository must be an explicit absolute path"))
  return yield* discoverPhysicalWorkingTreeRoot(repository)
})

/** Read-only administrative view; complete authored bytes retain comments and wording. */
export const inspectRules = Effect.fn("Rules.mcp.inspect")(function* (request: InspectRequest) {
  const repository = yield* resolveRepository(request.repository)
  const userConfigPath = Option.getOrUndefined(yield* Config.option(Config.NonEmptyString("REVIEW_USER_CONFIG_PATH")))
  const inventory = yield* loadRuleInventory(repository.root, userConfigPath === undefined ? {} : { userConfigPath })
  const selected = inventory.rules.filter((rule) => request.id === undefined || rule.id === request.id)
  if (request.id !== undefined && selected.length === 0)
    return yield* Effect.fail(new Error(`Unknown rule identity '${request.id}'`))
  const rules = yield* Effect.try({
    try: () =>
      selected.map((rule) => ({
        ...rule,
        content: rule.path === undefined ? undefined : readFileSync(rule.path, "utf8")
      })),
    catch: () => new Error("Authored rule content is unavailable; inspect again")
  })
  return { ...inventory, rules, classifierCalls: 0 }
})

/** Bounded serial checks preserve the existing request limits and independent policy owner. */
export const checkRules = Effect.fn("Rules.mcp.check")(function* (suppliedRequest: CheckRulesRequest) {
  const request = yield* Schema.decodeUnknownEffect(CheckRulesRequest, { onExcessProperty: "error" })(suppliedRequest)
  const repository = yield* resolveRepository(request.repository)
  let candidate: EffectiveRuleCandidate | undefined
  if (request.mode === "candidate") {
    const userConfigPath = Option.getOrUndefined(yield* Config.option(Config.NonEmptyString("REVIEW_USER_CONFIG_PATH")))
    const options = userConfigPath === undefined ? {} : { userConfigPath }
    const plan = yield* previewRuleChanges(repository.root, request.changes, options)
    if (plan.previewDigest !== request.previewDigest)
      return yield* Effect.fail(
        new Error("Candidate preview is stale or changed; inspect and preview again before checking.")
      )
    candidate = {
      settings: plan.settings,
      stillCurrent: previewRuleChanges(repository.root, request.changes, options).pipe(
        Effect.map((current) => current.previewDigest === request.previewDigest),
        Effect.catch(() => Effect.succeed(false))
      )
    }
  }
  const captured = yield* Effect.forEach(request.targets, (target) =>
    Effect.gen(function* () {
      let current: Effect.Effect<boolean, unknown> | undefined
      let classifierCalls = 0
      const outcome = yield* checkRuleAtLine(
        { ...target, ids: request.mode === "stored" ? request.ids : undefined },
        repository.root,
        {
          retainFreshness: (check) => {
            current = check
          },
          observeRequest: () => {
            classifierCalls++
          }
        },
        candidate
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            version: 1 as const,
            operation: "rule-check" as const,
            repository: repository.root,
            ...target,
            status: "unavailable" as const,
            classifierCalls,
            results: [],
            reason: localFailureMessage(error),
            explanation: "Check failed; no current judgment is available."
          })
        )
      )
      return { outcome, current }
    })
  )
  const outcomes = yield* Effect.forEach(captured, ({ outcome, current }) =>
    Effect.gen(function* () {
      if (
        outcome.status !== "evaluated" ||
        current === undefined ||
        (yield* current.pipe(Effect.catch(() => Effect.succeed(false))))
      )
        return outcome
      return {
        ...outcome,
        status: "unavailable" as const,
        reason: "stale-at-final-report",
        results: [],
        explanation: "Effective inputs changed before the batch report; recheck this target."
      }
    })
  )
  return {
    version: 1 as const,
    repository: repository.root,
    mode: request.mode,
    classifierCalls: outcomes.reduce((sum, outcome) => sum + outcome.classifierCalls, 0),
    outcomes
  }
})
