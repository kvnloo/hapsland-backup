import { afterEach, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { readFile, readdir, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { makeGitFixture, put } from "@hapsland/build-tooling/test-support/test-fixtures"
import { previewRules, checkRules, inspectRules } from "@hapsland/administration/rules/mcp/operations"
import { uncachedReviewSettingsLayer } from "@hapsland/review-definition/runtime/review-settings"
import { credentialResolverLayer } from "@hapsland/credential-storage/credentials/owner"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const content =
  JSON.stringify(
    {
      version: 1,
      id: "task/total-head",
      title: "Express an empty head result",
      question:
        "Does a function accepting an empty array promise a head value and throw instead of expressing the empty result?",
      criteria: {
        false: "Empty input has an explicit result or is excluded by the input type",
        true: "Empty input is admitted and throws instead of expressing an empty result"
      },
      message: "Express the empty result in the return type or exclude empty input.",
      inputs: [{ kind: "function", languages: ["typescript"], requires: ["signature", "body"] }]
    },
    null,
    2
  ) + "\n"
const change = {
  action: "create" as const,
  scope: "project" as const,
  path: ".hapsland/rules/custom/task%2Ftotal-head.jsonc",
  content,
  settings: { enabled: true, includes: ["target.ts"], threshold: 0.8 }
}
const fixture = async () => {
  const root = await makeGitFixture()
  roots.push(root)
  await put(root, ".hapsland.jsonc", '{ "version": 1, "rules": [], "credentialEnvVar": "CANDIDATE_KEY" }\n')
  await put(
    root,
    "target.ts",
    "export function head(xs: number[]): number { if (xs.length === 0) throw new Error('empty'); return xs[0]! }\n"
  )
  return root
}
const configuration = (root: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      REVIEW_USER_CONFIG_PATH: join(root, "missing-user.json"),
      CANDIDATE_KEY: "fixture-only"
    })
  )
const reviewer = (probability: number, beforeResponse: () => Promise<void> = async () => {}) => {
  const requests: string[] = []
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "")
      yield* Effect.promise(beforeResponse)
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          model: "jev-latest",
          answers: { "task/total-head": { type: "noul", noul: probability } },
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })
  )
  return { requests, client }
}
const checkCandidate = async (root: string, proposed = change, fake = reviewer(0.9)) => {
  const preview = await Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes: [proposed] }).pipe(
      Effect.provide(configuration(root))
    )
  )
  const result = await Effect.runPromise(
    checkRules({
      repository: root,
      mode: "candidate",
      targets: [{ path: "target.ts", line: 1 }],
      changes: [proposed],
      previewDigest: preview.previewDigest
    }).pipe(
      Effect.provide(uncachedReviewSettingsLayer),
      Effect.provide(credentialResolverLayer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, fake.client)),
      Effect.provide(configuration(root))
    )
  )
  return { preview, result, requests: fake.requests }
}

it("previews the exact Project content and effective connection/settings without writes", async () => {
  const root = await fixture()
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const result = await Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes: [change] }).pipe(
      Effect.provide(configuration(root))
    )
  )
  expect(result).toMatchObject({
    repository: root,
    classifierCalls: 0,
    changes: [change],
    previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    rules: [{ id: "task/total-head", enabled: true, threshold: 0.8, applicability: { includes: ["target.ts"] } }]
  })
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
  expect(await readdir(root)).not.toContain(".hapsland")
})

it("prepares the unsaved throwing-head candidate identically to its intended applied state", async () => {
  const root = await fixture()
  const preview = await Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes: [change] }).pipe(
      Effect.provide(configuration(root))
    )
  )
  const requests: string[] = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "")
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          model: "jev-latest",
          answers: { "task/total-head": { type: "noul", noul: 0.9 } },
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
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const candidate = await Effect.runPromise(
    checkRules({
      repository: root,
      mode: "candidate",
      targets: [{ path: "target.ts", line: 1 }],
      changes: [change],
      previewDigest: preview.previewDigest
    }).pipe(Effect.provide(dependencies))
  )
  expect(candidate).toMatchObject({
    repository: root,
    mode: "candidate",
    classifierCalls: 1,
    outcomes: [
      { status: "evaluated", results: [{ ruleId: "task/total-head", probability: 0.9, threshold: 0.8, finding: true }] }
    ]
  })
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
  const inventory = await Effect.runPromise(
    inspectRules({ repository: root, operation: "inspect" }).pipe(Effect.provide(configuration(root)))
  )
  expect(inventory.rules).toEqual([])
  for (const file of preview.files) {
    await mkdir(join(root, ".hapsland/rules/custom"), { recursive: true })
    await writeFile(file.path, file.after)
  }
  for (const file of preview.configurations) await writeFile(file.path, file.after)
  const applied = await Effect.runPromise(
    checkRules({ repository: root, mode: "stored", targets: [{ path: "target.ts", line: 1 }] }).pipe(
      Effect.provide(dependencies)
    )
  )
  expect(applied.outcomes[0]).toEqual(candidate.outcomes[0])
  expect(requests).toHaveLength(2)
  expect(requests[0]).toBe(requests[1])
})

it("retains a useful clear observation for an explicitly optional empty result", async () => {
  const root = await fixture()
  await put(root, "target.ts", "export function head(xs: number[]): number | undefined { return xs[0] }\n")
  const { result, requests } = await checkCandidate(root, change, reviewer(0.1))
  expect(result.outcomes[0]).toMatchObject({
    status: "evaluated",
    results: [{ probability: 0.1, threshold: 0.8, finding: false }]
  })
  expect(requests).toHaveLength(1)
})

it("explains a supported declaration's missing required evidence without a classifier request", async () => {
  const root = await fixture()
  await put(root, "target.ts", "export function head(xs: number[]): number { return missing(xs) }\n")
  const proposed = { ...change, content: content.replace('"body"', '"resolved-local-calls"') }
  const { result, requests } = await checkCandidate(root, proposed)
  expect(result.outcomes[0]).toMatchObject({
    status: "skipped",
    reason: "missing-evidence",
    classifierCalls: 0,
    results: []
  })
  expect(requests).toHaveLength(0)
})

it("rejects an unsupported documentation obligation rather than treating a skip as enforceability", async () => {
  const root = await fixture()
  const proposed = { ...change, content: content.replace('"body"', '"documentation-completeness"') }
  await expect(
    Effect.runPromise(
      previewRules({ repository: root, operation: "preview", changes: [proposed] }).pipe(
        Effect.provide(configuration(root))
      )
    )
  ).rejects.toMatchObject({ reason: expect.stringContaining("unsupported capability") })
  expect(await readdir(root)).not.toContain(".hapsland")
})

it("cannot use candidate selection to widen globally denied target reads", async () => {
  const root = await fixture()
  await put(
    root,
    ".hapsland.jsonc",
    JSON.stringify({ version: 1, rules: [], excludes: ["target.ts"], credentialEnvVar: "CANDIDATE_KEY" })
  )
  const { result, requests } = await checkCandidate(root)
  expect(result.outcomes[0]).toMatchObject({ status: "skipped", classifierCalls: 0, results: [] })
  expect(requests).toHaveLength(0)
  expect(JSON.stringify(result)).not.toContain("throw new Error")
})

it("keeps supporting-source exclusions when the candidate requires their evidence", async () => {
  const root = await fixture()
  await put(
    root,
    ".hapsland.jsonc",
    JSON.stringify({ version: 1, rules: [], contextExcludes: ["denied.ts"], credentialEnvVar: "CANDIDATE_KEY" })
  )
  await put(
    root,
    "target.ts",
    'import type { Hidden } from "./denied"; export function head(xs: Hidden[]): Hidden { return xs[0]! }\n'
  )
  await put(root, "denied.ts", "export type Hidden = { PRIVATE_SUPPORT_SENTINEL: string }\n")
  const proposed = { ...change, content: content.replace('"body"', '"resolved-outbound-types"') }
  const { result, requests } = await checkCandidate(root, proposed)
  expect(result.outcomes[0]).toMatchObject({
    status: "skipped",
    reason: "missing-evidence",
    classifierCalls: 0,
    results: []
  })
  expect(requests).toHaveLength(0)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SUPPORT_SENTINEL")
})

it("invalidates a candidate when its independently resolved policy changes during evaluation", async () => {
  const root = await fixture()
  const fake = reviewer(0.9, async () => {
    await put(
      root,
      ".hapsland.jsonc",
      JSON.stringify({ version: 1, rules: [], excludes: ["target.ts"], credentialEnvVar: "CANDIDATE_KEY" })
    )
  })
  const { result, requests } = await checkCandidate(root, change, fake)
  expect(result.outcomes[0]).toMatchObject({ status: "unavailable", reason: "stale", classifierCalls: 1, results: [] })
  expect(requests).toHaveLength(1)
  expect(await readdir(root)).not.toContain(".hapsland")
})

it("rejects a stale or changed candidate before dispatch", async () => {
  const root = await fixture()
  const preview = await Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes: [change] }).pipe(
      Effect.provide(configuration(root))
    )
  )
  const proposed = { ...change, settings: { ...change.settings, threshold: 0.6 } }
  const fake = reviewer(0.9)
  await expect(
    Effect.runPromise(
      checkRules({
        repository: root,
        mode: "candidate",
        targets: [{ path: "target.ts", line: 1 }],
        changes: [proposed],
        previewDigest: preview.previewDigest
      }).pipe(
        Effect.provide(uncachedReviewSettingsLayer),
        Effect.provide(credentialResolverLayer),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, fake.client)),
        Effect.provide(configuration(root))
      )
    )
  ).rejects.toThrow("stale or changed")
  expect(fake.requests).toHaveLength(0)
})

it("rejects non-rule policy overrides and unauthorized creation destinations without writes", async () => {
  const root = await fixture()
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const override = { ...change, settings: { ...change.settings, reviewBackend: { provider: "other" } } }
  for (const proposed of [override, { ...change, path: "target.ts" }]) {
    await expect(
      Effect.runPromise(
        previewRules({ repository: root, operation: "preview", changes: [proposed] }).pipe(
          Effect.provide(configuration(root))
        )
      )
    ).rejects.toThrow()
  }
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
  expect(await readFile(join(root, "target.ts"), "utf8")).toContain("export function head")
  expect(await readdir(root)).not.toContain(".hapsland")
})

it("preserves administration's refusal of a Project configuration symlink outside the working tree", async () => {
  const root = await fixture()
  const other = await fixture()
  const before = await readFile(join(other, ".hapsland.jsonc"), "utf8")
  await rm(join(root, ".hapsland.jsonc"))
  await symlink(join(other, ".hapsland.jsonc"), join(root, ".hapsland.jsonc"))
  await expect(
    Effect.runPromise(
      previewRules({ repository: root, operation: "preview", changes: [change] }).pipe(
        Effect.provide(configuration(root))
      )
    )
  ).rejects.toMatchObject({ reason: expect.stringContaining("stay inside") })
  expect(await readFile(join(other, ".hapsland.jsonc"), "utf8")).toBe(before)
  expect(await readdir(root)).not.toContain(".hapsland")
})
