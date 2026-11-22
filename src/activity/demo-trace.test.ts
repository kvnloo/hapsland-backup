import * as Effect from "effect/Effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterEach, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DirectAdvicee } from "@hapsland/native-observation/direct-event/observation"
import {
  demoSourceHash,
  readDemoTrace,
  recordDemoTraceEffect
} from "@hapsland/activity-observation/activity/demo-trace"
const recordDemoTrace = (...args: Parameters<typeof recordDemoTraceEffect>) =>
  Effect.runPromise(recordDemoTraceEffect(...args).pipe(Effect.provide(NodeFileSystem.layer)))
const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "demo-trace-"))
  roots.push(root)
  const budgetPath = join(root, "budget.json")
  writeFileSync(budgetPath, JSON.stringify({ root }))
  writeFileSync(join(root, "session.ts"), "type SyntheticCount = number\n")
  const advicee: DirectAdvicee = {
    agentRuntime: "claude-code",
    agentRuntimeVersion: "2.1.218",
    sessionId: "fixture-session",
    turnId: null,
    toolUseId: "tool",
    subagentId: null
  }
  return { root, budgetPath, advicee }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it("records bounded source-free metadata for the owned session", async () => {
  const { root, budgetPath, advicee } = fixture()
  const sourceHash = demoSourceHash(root)
  if (sourceHash === undefined) throw new Error("fixture source was not captured")
  await recordDemoTrace(budgetPath, root, advicee, {
    kind: "delivery",
    sourceHash,
    state: "findings",
    ruleIds: Array.from({ length: 20 }, (_, i) => `r${i}`)
  })
  await recordDemoTrace(budgetPath, root, advicee, { kind: "terminal", sourceHash, state: "clear" })
  const entries = readDemoTrace(budgetPath, advicee.sessionId)
  expect(entries).toHaveLength(2)
  expect(entries.find((entry) => entry.kind === "delivery")?.ruleIds).toHaveLength(16)
  expect(entries.every((entry) => entry.sourceHash === demoSourceHash(root))).toBe(true)
  for (const name of readdirSync(`${budgetPath}.trace`, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".json")
  ))
    expect(readFileSync(join(`${budgetPath}.trace`, name), "utf8")).not.toContain("SyntheticCount")
  expect(readDemoTrace(budgetPath, "other-session")).toEqual([])
})
it("fails quietly for missing evidence, an unowned root or invalid terminal identity", async () => {
  const { root, budgetPath, advicee } = fixture()
  for (const path of [undefined, null, join(root, "missing")])
    await recordDemoTrace(path, root, advicee, { kind: "edit" })
  await recordDemoTrace(budgetPath, `${root}-other`, advicee, { kind: "edit" })
  await recordDemoTrace(budgetPath, root, advicee, { kind: "terminal", sourceHash: "invalid" })
  await recordDemoTrace(budgetPath, root, advicee, { kind: "delivery" })
  await recordDemoTrace(budgetPath, root, advicee, { kind: "delivery", sourceHash: "invalid" })
  expect(readDemoTrace(budgetPath, advicee.sessionId)).toEqual([])
  expect(demoSourceHash(`${root}-other`)).toBeUndefined()
})
it("correlates delivery with evaluated source even after the current source changes", async () => {
  const { root, budgetPath, advicee } = fixture()
  const sourceHash = demoSourceHash(root)
  if (sourceHash === undefined) throw new Error("fixture source was not captured")
  writeFileSync(join(root, "session.ts"), "type SyntheticCount = { value: number }\n")
  await recordDemoTrace(budgetPath, root, advicee, { kind: "delivery", sourceHash, ruleIds: ["bare_domain_value"] })
  await recordDemoTrace(budgetPath, root, advicee, { kind: "edit" })
  const entries = readDemoTrace(budgetPath, advicee.sessionId)
  expect(entries.find((entry) => entry.kind === "delivery")?.sourceHash).toBe(sourceHash)
  expect(entries.find((entry) => entry.kind === "edit")?.sourceHash).toBe(demoSourceHash(root))
  expect(demoSourceHash(root)).not.toBe(sourceHash)
})
it("rejects malformed trace fields and sorts valid entries by recorded time", async () => {
  const { root: _root, budgetPath, advicee } = fixture()
  const directory = `${budgetPath}.trace`
  mkdirSync(directory)
  const valid = { version: 1, sessionId: advicee.sessionId, at: 20, kind: "edit", sourceHash: "a".repeat(64) }
  const invalids = [
    { version: 2 },
    { at: 1.5 },
    { kind: "other" },
    { sourceHash: "A".repeat(64) },
    { ruleIds: ["invalid space"] },
    { state: "other" }
  ]
  for (const [index, invalid] of invalids.entries())
    writeFileSync(join(directory, `${index}.json`), JSON.stringify({ ...valid, ...invalid }))
  writeFileSync(join(directory, "malformed.json"), "{")
  writeFileSync(join(directory, "ignored.txt"), JSON.stringify(valid))
  writeFileSync(join(directory, "later.json"), JSON.stringify(valid))
  writeFileSync(join(directory, "earlier.json"), JSON.stringify({ ...valid, at: 10 }))
  expect(readDemoTrace(budgetPath, advicee.sessionId).map((entry) => entry.at)).toEqual([10, 20])
})
it("does not touch the filesystem until the recording effect is executed", async () => {
  const { root, budgetPath, advicee } = fixture()
  const recording = recordDemoTraceEffect(budgetPath, root, advicee, { kind: "edit" })
  expect(() => readdirSync(`${budgetPath}.trace`)).toThrow()
  await Effect.runPromise(recording.pipe(Effect.provide(NodeFileSystem.layer)))
  expect(readDemoTrace(budgetPath, advicee.sessionId)).toHaveLength(1)
})
it("uses the caller Clock and preserves interruption of observational filesystem work", async () => {
  const { root, budgetPath, advicee } = fixture()
  const Clock = await import("effect/Clock")
  const FileSystem = await import("effect/FileSystem")
  const Exit = await import("effect/Exit")
  const Cause = await import("effect/Cause")
  const clock = {
    ...Clock.Clock.defaultValue(),
    currentTimeMillis: Effect.succeed(123),
    currentTimeMillisUnsafe: () => 123
  }
  await Effect.runPromise(
    recordDemoTraceEffect(budgetPath, root, advicee, { kind: "edit" }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(Clock.Clock, clock)
    )
  )
  expect(readDemoTrace(budgetPath, advicee.sessionId)[0]?.at).toBe(123)
  const interrupted = await Effect.runPromiseExit(
    recordDemoTraceEffect(budgetPath, root, advicee, { kind: "edit" }).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.interrupt }))
    )
  )
  expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
})
