import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { bunExecutable } from "@hapsland/runtime-environment/runtime/bun-runtime"
import * as Effect from "effect/Effect"
import { Deferred, Fiber } from "effect"
import { execFileAsync } from "../../scripts/test-harness/process.mjs"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEMO_PROVIDER_CALL_BUDGET,
  DEMO_SOURCE_BYTE_BUDGET,
  DEMO_TIME_BUDGET_MS,
  runFirstReviewDemo,
  correlatedHostEvidence,
  uninstrumentedHostEvidence,
  type DemoExecution,
  type DemoExecutor,
  DemoExecutionError
} from "@hapsland/administration/onboarding/first-review-demo"
import { claimDemoBudget, readDemoBudgetUsage } from "@hapsland/activity-observation/activity/demo-budget"
import {
  demoSourceHash,
  demoFeedbackDigest,
  readDemoTrace,
  recordDemoTraceEffect
} from "@hapsland/activity-observation/activity/demo-trace"
import { loadReviewSettings } from "@hapsland/review-definition/runtime/review-config"
import { connectDefaultRuleFixture, configuredRules } from "@hapsland/build-tooling/test-support/default-rules"

const recordDemoTrace = (...args: Parameters<typeof recordDemoTraceEffect>) =>
  Effect.runPromise(recordDemoTraceEffect(...args).pipe(Effect.provide(NodeFileSystem.layer)))
const roots: Array<string> = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "first-review-demo-test-"))
  roots.push(root)
  return { root, demoStatePath: join(root, "demos") }
}

const run = <A, E>(_test: ReturnType<typeof fixture>, effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

type Preview = Awaited<ReturnType<typeof preview>>
const preview = (test: ReturnType<typeof fixture>) =>
  run(
    test,
    runFirstReviewDemo(
      { version: 1, operation: "demo", selection: "preview" },
      { statePath: test.demoStatePath, installationReady: () => true }
    )
  )

const liveRequest = (value: Extract<Preview, { status: "preview" }>) => ({
  version: 1 as const,
  operation: "demo" as const,
  selection: "live" as const,
  demoId: value.demo.id,
  selectionDigest: value.authorization.selectionDigest
})

const completed: DemoExecution = {
  host: { completed: true, version: "codex-cli 0.155.1", durationMs: 700 },
  review: {
    findingRepairChainObserved: true,
    providerCalls: 2,
    submission: "submitted",
    findings: 1,
    modelReaction: { status: "observed", source: "correlated-finding-reaction", deliveredFindingCorrelation: true },
    followUp: {
      status: "completed",
      source: "post-repair-terminal-review",
      terminalState: "submitted",
      afterValidatedRepair: true
    },
    latencyMs: 420
  },
  repair: { changed: true, rejectsInvalidStates: true }
}

describe("installed-product first-review demo", async () => {
  it("records only source-free demo events for the budget-owned root", async () => {
    const test = fixture()
    const budget = join(test.root, "budget.json")
    writeFileSync(join(test.root, "session.ts"), "private synthetic source")
    const sourceHash = demoSourceHash(test.root)
    if (sourceHash === undefined) throw new Error("fixture source was not captured")
    writeFileSync(budget, JSON.stringify({ root: test.root }))
    const advicee = {
      agentRuntime: "codex-cli" as const,
      agentRuntimeVersion: "0.155.1" as const,
      sessionId: "session",
      turnId: "turn",
      toolUseId: "tool",
      subagentId: null
    }
    await recordDemoTrace(budget, join(test.root, "other"), advicee, {
      kind: "delivery",
      sourceHash,
      ruleIds: ["meaningless_combinations"]
    })
    expect(readDemoTrace(budget, "session")).toHaveLength(0)
    await recordDemoTrace(budget, test.root, advicee, {
      kind: "delivery",
      sourceHash,
      ruleIds: ["meaningless_combinations"]
    })
    expect(readDemoTrace(budget, "session")).toMatchObject([
      { kind: "delivery", ruleIds: ["meaningless_combinations"] }
    ])
    expect(
      readFileSync(
        join(
          `${budget}.trace`,
          readdirSync(`${budget}.trace`, { recursive: true, encoding: "utf8" }).find((name) =>
            name.endsWith(".json")
          ) ?? ""
        ),
        "utf8"
      )
    ).not.toContain("private synthetic source")
  })
  it("correlates delivered rule, later repair edit, final report, and terminal review of the validated source", async () => {
    const first = "a".repeat(64)
    const repaired = "b".repeat(64)
    const feedback = "A logged-out session still admits a user ID."
    const acted = (quote: string) => JSON.stringify({ reaction: { kind: "acted-on-feedback", quote } })
    const trace = [
      {
        version: 1 as const,
        sessionId: "session",
        at: 1,
        kind: "edit" as const,
        editedPath: "session.ts" as const,
        sourceHash: first
      },
      {
        version: 1 as const,
        sessionId: "session",
        at: 2,
        kind: "terminal" as const,
        sourceHash: first,
        state: "findings" as const
      },
      {
        version: 1 as const,
        sessionId: "session",
        at: 3,
        kind: "delivery" as const,
        sourceHash: first,
        ruleIds: ["meaningless_combinations"],
        feedbackDigests: [demoFeedbackDigest(feedback)]
      },
      {
        version: 1 as const,
        sessionId: "session",
        at: 4,
        kind: "edit" as const,
        editedPath: "session.ts" as const,
        sourceHash: repaired
      },
      {
        version: 1 as const,
        sessionId: "session",
        at: 5,
        kind: "terminal" as const,
        sourceHash: repaired,
        state: "clear" as const
      }
    ]
    const observed = {
      trace,
      finalSourceHash: repaired,
      hostEvents: [{ type: "item.completed", item: { type: "agent_message", text: acted(feedback) } }],
      finalReportAfterEdits: true,
      repairValidated: true
    }
    expect(correlatedHostEvidence(observed)).toMatchObject({
      modelReaction: { status: "observed", deliveredFindingCorrelation: true },
      followUp: { status: "completed", terminalState: "clear", afterValidatedRepair: true }
    })
    expect(correlatedHostEvidence({ ...observed, trace: trace.slice(0, 4) }).followUp.status).toBe("not-observed")
    for (const finalMessages of [
      ["Addressed meaningless_combinations"],
      [acted(feedback), JSON.stringify({ reaction: { kind: "no-reaction" } })],
      [acted("An unrelated finding.")],
      ["I did not react to meaningless_combinations; validation passed."]
    ]) {
      expect(
        correlatedHostEvidence({
          ...observed,
          hostEvents: finalMessages.map((text) => ({ type: "item.completed", item: { type: "agent_message", text } }))
        })
      ).toMatchObject({ modelReaction: { status: "not-observed" }, followUp: { status: "completed" } })
    }
    expect(
      correlatedHostEvidence({
        ...observed,
        hostEvents: [...observed.hostEvents, { type: "item.completed", item: { type: "agent_message", text: 12 } }]
      }).modelReaction.status
    ).toBe("not-observed")
    expect(correlatedHostEvidence({ ...observed, finalReportAfterEdits: false }).modelReaction.status).toBe(
      "not-observed"
    )
    expect(
      correlatedHostEvidence({ ...observed, trace: trace.filter((entry) => entry.kind !== "delivery") }).modelReaction
        .status
    ).toBe("unavailable")
    expect(
      correlatedHostEvidence({
        ...observed,
        trace: trace.map((entry) =>
          entry.kind === "edit" && entry.sourceHash === repaired ? { ...entry, at: 2 } : entry
        )
      }).modelReaction.status
    ).toBe("not-observed")
    for (const changedTrace of [
      trace.map((entry) => (entry.kind === "edit" && entry.sourceHash === repaired ? { ...entry, at: 3 } : entry)),
      trace.map((entry) =>
        entry.kind === "edit" && entry.sourceHash === repaired ? { ...entry, sourceHash: "c".repeat(64) } : entry
      ),
      trace.map((entry) => (entry.kind === "terminal" && entry.sourceHash === repaired ? { ...entry, at: 4 } : entry))
    ]) {
      const result = correlatedHostEvidence({ ...observed, trace: changedTrace })
      expect(result.followUp.status).toBe("not-observed")
    }
    expect(
      correlatedHostEvidence({
        ...observed,
        trace: [
          ...trace.slice(0, 2),
          { ...trace[2]!, feedbackDigests: [demoFeedbackDigest("An unrelated earlier delivery.")] },
          { ...trace[2]!, at: 4 },
          ...trace.slice(3).map((entry) => ({ ...entry, at: entry.at + 1 }))
        ]
      })
    ).toMatchObject({ modelReaction: { status: "observed" }, followUp: { status: "completed" } })
    expect(correlatedHostEvidence({ ...observed, repairValidated: false }).followUp.status).toBe("not-observed")
    expect(correlatedHostEvidence({ ...observed, repairValidated: false }).modelReaction.status).toBe("observed")
    const crossed = correlatedHostEvidence({
      ...observed,
      trace: [
        ...trace.slice(0, 2),
        { ...trace[2]!, feedbackDigests: [demoFeedbackDigest("earlier feedback")] },
        ...trace.slice(3),
        { ...trace[2]!, at: 6, sourceHash: repaired },
        { ...trace[3]!, at: 7, sourceHash: "c".repeat(64) }
      ]
    })
    expect(crossed).toMatchObject({
      modelReaction: { status: "observed" },
      followUp: { status: "completed" },
      findingRepairChainObserved: false
    })
    const quotedRevert = correlatedHostEvidence({
      ...observed,
      trace: [
        { ...trace[2]!, feedbackDigests: [demoFeedbackDigest("other feedback")] },
        { ...trace[2]!, at: 4, sourceHash: repaired },
        { ...trace[3]!, at: 5, sourceHash: "c".repeat(64) },
        { ...trace[3]!, at: 6 },
        { ...trace[4]!, at: 7 }
      ]
    })
    expect(quotedRevert).toMatchObject({
      modelReaction: { status: "observed" },
      followUp: { status: "completed" },
      findingRepairChainObserved: false
    })
    const laterRepair = correlatedHostEvidence({
      ...observed,
      trace: [
        ...trace.map((entry) =>
          entry.kind === "delivery" ? { ...entry, feedbackDigests: [demoFeedbackDigest("other feedback")] } : entry
        ),
        { ...trace[2]!, at: 6 },
        { ...trace[3]!, at: 7 },
        { ...trace[4]!, at: 8 }
      ]
    })
    expect(laterRepair.findingRepairChainObserved).toBe(true)
    expect(
      correlatedHostEvidence({
        ...observed,
        trace: trace.map((entry) =>
          entry.kind === "terminal" && entry.sourceHash === repaired ? { ...entry, sourceHash: first } : entry
        )
      }).followUp.status
    ).toBe("not-observed")
  })
  it("does not infer reaction or follow-up from generic positive-looking host observations", async () => {
    expect(
      uninstrumentedHostEvidence({
        messages: 3,
        changed: true,
        repairValidated: true,
        terminalReviews: 2,
        findingSubmitted: true
      })
    ).toEqual({
      findingRepairChainObserved: false,
      modelReaction: { status: "unavailable", reason: "host-model-reaction-not-instrumented" },
      followUp: { status: "unavailable", reason: "post-repair-review-not-instrumented" }
    })
  })

  it("does not create a demo before installation setup is complete", async () => {
    const test = fixture()
    const result = await run(
      test,
      runFirstReviewDemo(
        { version: 1, operation: "demo", selection: "preview" },
        { statePath: test.demoStatePath, installationReady: () => false }
      )
    )
    expect(result).toMatchObject({ status: "conflict", paidVerificationPerformed: false, providerCalls: 0 })
    expect(existsSync(test.demoStatePath)).toBe(false)
  })

  it("checks the selected installation before creating a disposable project", async () => {
    const test = fixture()
    const result = await run(
      test,
      runFirstReviewDemo(
        {
          version: 1,
          operation: "demo",
          selection: "preview",
          codexHome: join(test.root, "missing-home"),
          codexExecutable: join(test.root, "missing-codex")
        },
        { statePath: test.demoStatePath }
      )
    )
    expect(result).toMatchObject({ status: "conflict", providerCalls: 0, paidVerificationPerformed: false })
    expect(existsSync(test.demoStatePath)).toBe(false)
  })

  it("keeps preview offline and discloses the synthetic input and exact budgets", async () => {
    const test = fixture()
    const result = await preview(test)
    expect(result.status).toBe("preview")
    if (result.status !== "preview") throw new Error("expected preview")
    expect(result.liveSelected).toBe(false)
    expect(result.paidVerificationPerformed).toBe(false)
    expect(result.demo.syntheticOnly).toBe(true)
    expect(result.demo.disclosure.deliberatelyFlawed).toBe(true)
    expect(result.demo.disclosure.repairPrescribed).toBe(false)
    expect(result.demo.disclosure.intendedInvalidStates).toHaveLength(2)
    expect(result.demo.disclosure.source).toContain("export interface Session")
    expect(result.budget).toEqual({
      sourceBytes: DEMO_SOURCE_BYTE_BUDGET,
      providerCalls: DEMO_PROVIDER_CALL_BUDGET,
      timeMs: DEMO_TIME_BUDGET_MS
    })
    expect(existsSync(result.demo.disposableRoot)).toBe(true)
    const settings = await run(
      test,
      loadReviewSettings(result.demo.disposableRoot, { userConfigPath: join(test.root, "user.jsonc") })
    )
    expect(settings.configuration.policy.layers.find((layer) => layer.name === "project")?.document.includes).toEqual([
      "session.ts"
    ])
    await run(
      test,
      runFirstReviewDemo(
        { version: 1, operation: "demo", selection: "cancel", demoId: result.demo.id },
        { statePath: test.demoStatePath }
      )
    )
    expect(existsSync(result.demo.disposableRoot)).toBe(false)
  })

  it("requires the exact live-selection digest", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    let executions = 0
    const execute: DemoExecutor = () =>
      Effect.sync<DemoExecution>(() => {
        executions += 1
        return completed
      })
    const result = await run(
      test,
      runFirstReviewDemo(
        { ...liveRequest(proposal), selectionDigest: "0".repeat(64) },
        { statePath: test.demoStatePath, execute }
      )
    )
    expect(result.status).toBe("proposal-mismatch")
    expect(executions).toBe(0)
    expect(existsSync(proposal.demo.disposableRoot)).toBe(true)
    await run(
      test,
      runFirstReviewDemo(
        { version: 1, operation: "demo", selection: "cancel", demoId: proposal.demo.id },
        { statePath: test.demoStatePath }
      )
    )
  })

  it("interrupting claimed execution removes its owned root, claim and budget before returning", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    await run(
      test,
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const running = yield* Effect.forkChild(
          runFirstReviewDemo(liveRequest(proposal), {
            statePath: test.demoStatePath,
            execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          }),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        expect(existsSync(proposal.demo.disposableRoot)).toBe(true)
        expect(existsSync(join(test.demoStatePath, `${proposal.demo.id}.claimed`))).toBe(true)
        yield* Fiber.interrupt(running)
        expect((yield* Fiber.await(running))._tag).toBe("Failure")
        expect(existsSync(proposal.demo.disposableRoot)).toBe(false)
        expect(readdirSync(test.demoStatePath)).toEqual([])
      })
    )
  })

  it("retains sanitized budget usage when execution fails after reserving a call", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    const result = await run(
      test,
      runFirstReviewDemo(liveRequest(proposal), {
        statePath: test.demoStatePath,
        execute: (options) =>
          Effect.sync(() => claimDemoBudget(options.budgetPath, options.root, 100)).pipe(
            Effect.andThen(Effect.fail(new DemoExecutionError({ operation: "synthetic interrupted observation" })))
          )
      })
    )
    expect(result).toMatchObject({
      status: "incomplete",
      paidVerificationPerformed: true,
      evidence: { providerCalls: 1, sourceBytes: 100 },
      cleanup: { disposableRootRemoved: true }
    })
    expect(readdirSync(test.demoStatePath)).toEqual([])
  })

  it("runs the default executor against a synthetic host and reports UTF-8 bytes before cleanup", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    const executable = join(test.root, "synthetic-host.cjs")
    const promptPath = join(test.root, "prompt.json")
    const paths = connectDefaultRuleFixture(proposal.demo.disposableRoot)
    writeFileSync(
      join(proposal.demo.disposableRoot, ".hapsland.jsonc"),
      JSON.stringify({
        version: 1,
        includes: ["session.ts"],
        rules: paths.map((path, index) => ({ path, enabled: index === 0 }))
      })
    )
    const stdout = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "synthetic 🌲" } })}\n`
    const stderr = "é"
    writeFileSync(
      executable,
      `#!${process.execPath}\nif(process.argv[2]==="--version")process.stdout.write("synthetic-host\\n");else{require("node:fs").writeFileSync(${JSON.stringify(promptPath)},JSON.stringify(process.argv.at(-1)));process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});}\n`,
      { mode: 0o700 }
    )
    const result = await run(
      test,
      runFirstReviewDemo({ ...liveRequest(proposal), codexExecutable: executable }, { statePath: test.demoStatePath })
    )
    expect(result).toMatchObject({
      status: "inconclusive",
      paidVerificationPerformed: false,
      evidence: {
        agentRuntimeVersion: "synthetic-host",
        hostFailure: null,
        hostStdoutBytes: Buffer.byteLength(stdout, "utf8"),
        hostStderrBytes: Buffer.byteLength(stderr, "utf8"),
        hostEventCounts: { agentMessages: 1 },
        providerCalls: 0
      },
      cleanup: { disposableRootRemoved: true }
    })
    expect(existsSync(proposal.demo.disposableRoot)).toBe(false)
    const prompt: unknown = JSON.parse(readFileSync(promptPath, "utf8"))
    const selected = configuredRules.find((rule) => rule.ruleId === "meaningless_combinations")
    if (selected === undefined) throw new Error("fixture rule was not configured")
    expect(prompt).not.toContain(selected.ruleId)
    expect(prompt).not.toContain(selected.message)
    expect(prompt).not.toContain("bare_domain_value")
    expect(readdirSync(test.demoStatePath)).toEqual([])
  })

  it("atomically consumes one confirmation across processes and admits at most two calls", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    const dispatchMarkerPath = join(test.root, "dispatches.log")
    const workerInputPath = join(test.root, "race-input.json")
    writeFileSync(
      workerInputPath,
      JSON.stringify({ request: liveRequest(proposal), demoStatePath: test.demoStatePath, dispatchMarkerPath })
    )
    const worker = new URL("../../scripts/first-review-race-worker.mjs", import.meta.url).pathname
    const runs = await Promise.all([
      execFileAsync(bunExecutable(), [worker, workerInputPath]),
      execFileAsync(bunExecutable(), [worker, workerInputPath])
    ])
    const results = runs.map(({ stdout }) => JSON.parse(stdout) as { readonly status: string })
    expect(results.filter(({ status }) => status === "passed")).toHaveLength(1)
    expect(results.filter(({ status }) => status === "conflict")).toHaveLength(1)
    const possibleCalls = readFileSync(dispatchMarkerPath, "utf8").trim().split("\n").filter(Boolean)
    expect(possibleCalls).toHaveLength(2)

    let replayExecutions = 0
    const replay = await run(
      test,
      runFirstReviewDemo(liveRequest(proposal), {
        statePath: test.demoStatePath,
        execute: () =>
          Effect.sync<DemoExecution>(() => {
            replayExecutions += 1
            return completed
          })
      })
    )
    expect(replay.status).toBe("conflict")
    expect(replayExecutions).toBe(0)
  })

  it("retains distinct sanitized stages, validates repair independently, and cleans up", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    const result = await run(
      test,
      runFirstReviewDemo(liveRequest(proposal), {
        statePath: test.demoStatePath,
        execute: (options) =>
          Effect.sync<DemoExecution>(() => {
            expect(readDemoBudgetUsage(options.budgetPath)).toEqual({ sourceBytes: 0, providerCalls: 0 })
            claimDemoBudget(options.budgetPath, options.root, 100)
            claimDemoBudget(options.budgetPath, options.root, 100)
            return completed
          })
      })
    )
    expect(result.status).toBe("passed")
    if (!("evidence" in result)) throw new Error("expected evidence")
    expect(result.evidence).toMatchObject({
      completion: "completed",
      submission: "submitted",
      findings: 1,
      modelReaction: "observed",
      modelReactionSource: "correlated-finding-reaction",
      deliveredFindingCorrelation: true,
      repair: "independently-validated",
      followUpReview: "completed",
      providerCalls: 2,
      sourceRetained: false,
      responsesRetained: false
    })
    expect(result.setup).toEqual({ actions: 0, durationMs: 0 })
    expect(result.reviewLatencyMs).toBe(420)
    expect(result.cleanup).toEqual({ disposableRootRemoved: true })
    expect(existsSync(proposal.demo.disposableRoot)).toBe(false)
  })

  it("does not pass when either independent reaction or post-repair terminal evidence is unavailable", async () => {
    const missingReaction = fixture()
    const reactionProposal = await preview(missingReaction)
    if (reactionProposal.status !== "preview") throw new Error("expected preview")
    const reactionResult = await run(
      missingReaction,
      runFirstReviewDemo(liveRequest(reactionProposal), {
        statePath: missingReaction.demoStatePath,
        execute: () =>
          Effect.sync<DemoExecution>(() => ({
            ...completed,
            review: {
              ...completed.review,
              modelReaction: { status: "unavailable", reason: "host-model-reaction-not-instrumented" }
            }
          }))
      })
    )
    expect(reactionResult.status).toBe("inconclusive")
    if (!("evidence" in reactionResult)) throw new Error("expected reaction evidence")
    expect(reactionResult.evidence).toMatchObject({
      modelReaction: "unavailable",
      modelReactionSource: "unavailable",
      deliveredFindingCorrelation: false
    })

    const missingFollowUp = fixture()
    const followUpProposal = await preview(missingFollowUp)
    if (followUpProposal.status !== "preview") throw new Error("expected preview")
    const followUpResult = await run(
      missingFollowUp,
      runFirstReviewDemo(liveRequest(followUpProposal), {
        statePath: missingFollowUp.demoStatePath,
        execute: () =>
          Effect.sync<DemoExecution>(() => ({
            ...completed,
            review: {
              ...completed.review,
              followUp: { status: "unavailable", reason: "post-repair-review-not-instrumented" }
            }
          }))
      })
    )
    expect(followUpResult.status).toBe("inconclusive")
  })

  it("reports stochastic misses and budget overruns as inconclusive", async () => {
    const test = fixture()
    const proposal = await preview(test)
    if (proposal.status !== "preview") throw new Error("expected preview")
    const result = await run(
      test,
      runFirstReviewDemo(liveRequest(proposal), {
        statePath: test.demoStatePath,
        execute: () =>
          Effect.sync<DemoExecution>(() => ({
            host: { completed: true, version: "codex-cli 0.155.1", durationMs: 900 },
            review: {
              findingRepairChainObserved: false,
              providerCalls: 3,
              submission: "none",
              findings: 0,
              modelReaction: { status: "not-observed", source: "correlated-finding-reaction" },
              followUp: { status: "not-observed", source: "post-repair-terminal-review" }
            },
            repair: { changed: false, rejectsInvalidStates: false }
          }))
      })
    )
    expect(result.status).toBe("inconclusive")
    if (result.status !== "inconclusive" || !("evidence" in result)) throw new Error("expected evidence")
    expect(result.budget.observedWithinBudget).toBe(false)
    expect(result.evidence).toMatchObject({
      submission: "none",
      findings: 0,
      modelReaction: "not-observed",
      modelReactionSource: "correlated-finding-reaction",
      deliveredFindingCorrelation: false,
      repair: "not-validated",
      followUpReview: "not-observed",
      providerCalls: 3
    })
  })
})
