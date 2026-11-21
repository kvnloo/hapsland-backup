import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { isAbsolute, posix } from "node:path"
import { readFileSync } from "node:fs"
import { discoverPhysicalWorkingTreeRoot } from "@hapsland/native-observation/repository/root"
import { localFailureMessage } from "../../invocation/failure-message.ts"
import { loadRuleInventory } from "../inventory.ts"
import { checkRuleAtLine } from "../check.ts"

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
export const checkRules = Effect.fn("Rules.mcp.check")(function* (request: StoredCheckRequest) {
  yield* Schema.decodeUnknownEffect(StoredCheckRequest)(request)
  const repository = yield* resolveRepository(request.repository)
  const captured = yield* Effect.forEach(request.targets, (target) =>
    Effect.gen(function* () {
      let current: Effect.Effect<boolean, unknown> | undefined
      let classifierCalls = 0
      const outcome = yield* checkRuleAtLine({ ...target, ids: request.ids }, repository.root, {
        retainFreshness: (check) => {
          current = check
        },
        observeRequest: () => {
          classifierCalls++
        }
      }).pipe(
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
