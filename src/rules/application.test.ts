import { afterEach, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import { readFile, rm, mkdir, chmod, stat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { makeGitFixture, put } from "@hapsland/build-tooling/test-support/test-fixtures"
import { previewRules, applyRules, checkRules } from "@hapsland/administration/rules/mcp/operations"
import { loadRuleInventory } from "@hapsland/administration/rules/inventory"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import { withInstallationLock } from "@hapsland/administration/onboarding/installation-lock"
import { applyRuleChanges, applyRuleChange, previewRuleChange } from "@hapsland/administration/rules/management"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { credentialResolverLayer } from "@hapsland/credential-storage/credentials/owner"
import { uncachedReviewSettingsLayer } from "@hapsland/review-definition/runtime/review-settings"
import { initialRules, reduceRules } from "@hapsland/administration/rules/interaction-model"
import * as ConfigProvider from "effect/ConfigProvider"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const content =
  "// Exact operator wording, including this comment.\n" +
  JSON.stringify(
    {
      version: 1,
      id: "task/declared-result",
      title: "Return a declared result",
      question: "Does an admitted input throw instead of returning an explicitly declared result?",
      criteria: {
        false: "Returns a declared result or input excludes the case",
        true: "Admitted input throws rather than returning a declared result"
      },
      message: "Express the admitted empty result or narrow the input.",
      inputs: [{ kind: "function", languages: ["typescript"], requires: ["signature", "body"] }]
    },
    null,
    2
  ) +
  "\n"
const change = {
  action: "create" as const,
  scope: "project" as const,
  path: ".hapsland/rules/custom/task%2Fdeclared-result.jsonc",
  content,
  settings: { enabled: true, threshold: 0.8, includes: ["target.ts"] }
}
const fixture = async () => {
  const root = await makeGitFixture()
  roots.push(root)
  await put(
    root,
    ".hapsland.jsonc",
    '{ "version": 1, "rules": [], "excludes": ["private/**"], "credentialEnvVar": "APPLICATION_KEY" }\n'
  )
  await put(
    root,
    "target.ts",
    "export function head(xs: number[]): number { if (!xs.length) throw new Error('empty'); return xs[0]! }\n"
  )
  return root
}
const options = (root: string) => ({ userConfigPath: join(root, "missing-user.json") })
const configuration = (root: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      REVIEW_USER_CONFIG_PATH: options(root).userConfigPath,
      APPLICATION_KEY: "fixture-only"
    })
  )
const preview = (root: string, changes = [change]) =>
  Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes }).pipe(Effect.provide(configuration(root)))
  )

it("applies the exact previewed body and configuration effects, then observes saved and active state", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  const result = await Effect.runPromise(applyRuleChanges(root, [change], proposed.previewDigest, options(root)))
  expect(result).toMatchObject({
    repository: root,
    status: "completed",
    classifierCalls: 0,
    files: [{ id: "task/declared-result", saved: "exact", activation: "enabled" }],
    configurations: [{ write: "completed", observed: "exact" }]
  })
  expect(await readFile(join(root, change.path), "utf8")).toBe(content)
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(proposed.configurations[0]?.after)
  const actual = await Effect.runPromise(loadRuleInventory(root, options(root)))
  expect(actual.rules).toMatchObject([{ id: "task/declared-result", enabled: true, threshold: 0.8 }])
  expect(actual.policy.excludes.map((pattern) => pattern.value)).toContain("private/**")
})

it.each(["content", "settings", "configuration"])(
  "rejects changed %s before any rule/configuration write",
  async (field) => {
    const root = await fixture()
    const proposed = await preview(root)
    const changed =
      field === "content"
        ? { ...change, content: content + "\n" }
        : field === "settings"
          ? { ...change, settings: { ...change.settings, threshold: 0.6 } }
          : change
    if (field === "configuration")
      await put(root, ".hapsland.jsonc", '{"version":1,"rules":[],"excludes":["later/**"]}\n')
    const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
    const result = await Effect.runPromise(
      applyRuleChanges(root, [changed], proposed.previewDigest, options(root)).pipe(Effect.result)
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: expect.stringContaining("stale or changed") } })
    expect(await readdir(root)).not.toContain(".hapsland")
    expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
  }
)

it("rejects an unauthorized destination before writes", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  const before = await readFile(join(root, "target.ts"), "utf8")
  await expect(
    Effect.runPromise(applyRuleChanges(root, [{ ...change, path: "target.ts" }], proposed.previewDigest, options(root)))
  ).rejects.toMatchObject({ reason: expect.stringContaining("authorized Project") })
  expect(await readFile(join(root, "target.ts"), "utf8")).toBe(before)
  expect(await readdir(root)).not.toContain(".hapsland")
})

it("reports an actual content/configuration partial failure and repairs only through a renewed ordinary preview", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  await mkdir(join(root, ".hapsland/rules/custom"), { recursive: true })
  await Effect.runPromise(withInstallationLock(join(root, ".hapsland.jsonc.rules-lock"), Effect.void))
  const originalMode = (await stat(root)).mode & 0o777
  let result: Effect.Success<ReturnType<typeof applyRuleChanges>> | undefined
  try {
    await chmod(root, 0o500)
    result = await Effect.runPromise(applyRuleChanges(root, [change], proposed.previewDigest, options(root)))
  } finally {
    await chmod(root, originalMode)
  }
  expect(result).toMatchObject({
    status: "partial",
    files: [{ saved: "exact", activation: "not-connected", write: "completed" }],
    configurations: [{ write: "incomplete", observed: "different" }],
    classifierCalls: 0,
    validation: "not-run"
  })
  expect(await readFile(join(root, change.path), "utf8")).toBe(content)
  const actual = await Effect.runPromise(loadRuleInventory(root, options(root)))
  expect(actual.rules).toEqual([])
  // Recovery is an ordinary newly previewed connection, not replay or restoration of the failed proposal.
  const connect = { action: "connect" as const, scope: "project" as const, path: join(root, change.path) }
  const renewed = await Effect.runPromise(previewRuleChange(root, connect, options(root)))
  expect(renewed.ruleAfter).toBe(content)
  await Effect.runPromise(applyRuleChange(root, connect, renewed.digest, options(root)))
  expect((await Effect.runPromise(loadRuleInventory(root, options(root)))).rules).toMatchObject([
    { id: "task/declared-result", enabled: true }
  ])
})

it("retains the existing mutation-lock failure without applying user-state changes", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        withInstallationLock(
          join(root, ".hapsland.jsonc.rules-lock"),
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined)
            yield* Deferred.await(release)
          })
        )
      )
      yield* Deferred.await(acquired)
      const attempted = yield* applyRuleChanges(root, [change], proposed.previewDigest, options(root)).pipe(
        Effect.result
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      return attempted
    })
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: expect.stringContaining("lock remained busy") } })
  expect(await readdir(root)).not.toContain(".hapsland")
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
})

it("adapts the identical complete proposal through the MCP application operation", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  const result = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes: [change], previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(root))
    )
  )
  expect(result).toMatchObject({
    repository: root,
    status: "completed",
    files: [{ saved: "exact", activation: "enabled" }]
  })
  expect(await readFile(join(root, change.path), "utf8")).toBe(content)
})

it("walks deterministic candidate validation, recorded Save, application and focused task repair/recheck", async () => {
  const root = await fixture()
  const proposed = await preview(root)
  let probability = 0.9
  const requests: string[] = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "")
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          model: "jev-latest",
          answers: { "task/declared-result": { type: "noul", noul: probability } },
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })
  )
  const dependencies = Layer.mergeAll(
    uncachedReviewSettingsLayer,
    credentialResolverLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    configuration(root)
  )
  const check = (request: Parameters<typeof checkRules>[0]) =>
    Effect.runPromise(checkRules(request).pipe(Effect.provide(dependencies)))
  // Expected finding: admitted empty input throws instead of returning an explicitly declared result.
  const candidate = await check({
    repository: root,
    mode: "candidate",
    changes: [change],
    previewDigest: proposed.previewDigest,
    targets: [{ path: "target.ts", line: 1 }]
  })
  expect(candidate.outcomes[0]).toMatchObject({
    status: "evaluated",
    results: [{ probability: 0.9, threshold: 0.8, finding: true }]
  })
  expect((await Effect.runPromise(loadRuleInventory(root, options(root)))).rules).toEqual([])
  const plan = {
    action: "create" as const,
    scope: "project" as const,
    digest: proposed.previewDigest,
    configuration: join(root, ".hapsland.jsonc"),
    rule: join(root, change.path),
    enabled: true
  }
  let model = initialRules("create")
  model = reduceRules(model, { revision: model.revision, action: { kind: "scope", scope: "project" } })
  model = reduceRules(model, {
    revision: model.revision,
    action: { kind: "previewed", commandId: model.revision, plan }
  })
  model = reduceRules(model, { revision: model.revision, action: { kind: "continue" } })
  model = reduceRules(model, {
    revision: model.revision,
    action: { kind: "approve", choice: "save", digest: proposed.previewDigest }
  })
  expect(model.phase).toBe("Applying")
  // The recorded reducer choice is controlled test input, not evidence of real human consent.
  const saved = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes: [change], previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(root))
    )
  )
  expect(saved).toMatchObject({ status: "completed", files: [{ saved: "exact", activation: "enabled" }] })
  const affected = {
    repository: root,
    mode: "stored" as const,
    ids: ["task/declared-result"],
    targets: [{ path: "target.ts", line: 1 }]
  }
  expect((await check(affected)).outcomes[0]).toMatchObject({ status: "evaluated", results: [{ finding: true }] })
  // This fixture's operator intends an explicit optional empty result; always-number would require another remedy.
  await put(root, "target.ts", "export function head(xs: number[]): number | undefined { return xs[0] }\n")
  probability = 0.1
  expect((await check(affected)).outcomes[0]).toMatchObject({
    status: "evaluated",
    results: [{ probability: 0.1, threshold: 0.8, finding: false }]
  })
  expect(await readFile(join(root, change.path), "utf8")).toBe(content)
  expect(requests).toHaveLength(3)
  expect(requests[2]).toContain("number | undefined")
})
