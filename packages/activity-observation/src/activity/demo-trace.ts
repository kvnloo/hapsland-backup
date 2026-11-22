import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import * as Clock from "effect/Clock"
import * as FileSystem from "effect/FileSystem"
import type { DirectAdvicee } from "@hapsland/native-observation/direct-event/observation"

const Trace = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  at: Schema.Number.check(Schema.makeFilter(Number.isSafeInteger)),
  kind: Schema.Literals(["edit", "delivery", "terminal"]),
  editedPath: Schema.optionalKey(Schema.Literal("session.ts")),
  sourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ruleIds: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9_/-]{1,100}$/)))),
  feedbackDigests: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)))),
  state: Schema.optionalKey(Schema.Literals(["clear", "findings"]))
})
interface Trace extends Schema.Schema.Type<typeof Trace> {}
const isTrace = Schema.is(Trace)
type TraceEntry = {
  readonly kind: Trace["kind"]
  readonly sourceHash?: string
  readonly ruleIds?: readonly string[]
  readonly feedbackMessages?: readonly string[]
  readonly state?: "clear" | "findings"
}
const OwnedBudget = Schema.Struct({ root: Schema.String })
const isOwnedBudget = Schema.is(OwnedBudget)
const traceRuleIds = (ruleIds: readonly string[] | undefined) =>
  ruleIds === undefined ? {} : { ruleIds: ruleIds.slice(0, 16) }
const traceState = (state: Trace["state"]) => (state === undefined ? {} : { state })
export const demoFeedbackDigest = (message: string): string => createHash("sha256").update(message).digest("hex")

/** Lazy observational IO: expected evidence failures omit evidence; caller interruption remains interruption. */
export const recordDemoTraceEffect = (
  budgetPath: string | null | undefined,
  root: string,
  advicee: DirectAdvicee,
  entry: TraceEntry
) =>
  Effect.gen(function* () {
    if (budgetPath == null) return
    const fs = yield* FileSystem.FileSystem
    const encoded = yield* fs.readFileString(budgetPath)
    const budget: unknown = yield* Effect.try(() => JSON.parse(encoded))
    if (!isOwnedBudget(budget) || budget.root !== root) return
    const sourceHash =
      entry.kind === "edit"
        ? createHash("sha256")
            .update(yield* fs.readFile(join(root, "session.ts")))
            .digest("hex")
        : entry.sourceHash
    if (sourceHash === undefined || !/^[a-f0-9]{64}$/.test(sourceHash)) return
    const directory = `${budgetPath}.trace`
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const trace: Trace = {
      version: 1,
      sessionId: advicee.sessionId,
      at: yield* Clock.currentTimeMillis,
      kind: entry.kind,
      sourceHash,
      ...(entry.kind === "edit" ? { editedPath: "session.ts" as const } : {}),
      ...traceRuleIds(entry.ruleIds),
      ...(entry.feedbackMessages === undefined
        ? {}
        : { feedbackDigests: entry.feedbackMessages.slice(0, 16).map(demoFeedbackDigest) }),
      ...traceState(entry.state)
    }
    const path = yield* fs.makeTempFile({ directory, prefix: "trace-", suffix: ".json" })
    yield* fs.chmod(path, 0o600)
    yield* fs.writeFileString(path, `${JSON.stringify(trace)}\n`)
  }).pipe(
    Effect.catch(() => Effect.void),
    Effect.interruptible
  )
export type DemoTraceRecorder = (...args: Parameters<typeof recordDemoTraceEffect>) => Effect.Effect<void>
const readTraceEntry = (path: string, sessionId: string): readonly Trace[] => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isTrace(value) && value.sessionId === sessionId ? [value] : []
  } catch {
    return []
  }
}

export const demoSourceHash = (root: string): string | undefined => {
  try {
    return createHash("sha256")
      .update(readFileSync(join(root, "session.ts")))
      .digest("hex")
  } catch {
    return undefined
  }
}

export const readDemoTrace = (budgetPath: string, sessionId: string): readonly Trace[] => {
  try {
    return readdirSync(`${budgetPath}.trace`, { recursive: true, encoding: "utf8" })
      .flatMap((name) => (name.endsWith(".json") ? readTraceEntry(join(`${budgetPath}.trace`, name), sessionId) : []))
      .sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}
