import { afterEach, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { readFile, rm, symlink, mkdir, chmod, stat } from "node:fs/promises"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import { withInstallationLock } from "@hapsland/administration/onboarding/installation-lock"
import { join } from "node:path"
import { makeGitFixture, put } from "@hapsland/build-tooling/test-support/test-fixtures"
import { previewRules, applyRules, inspectRules, checkRules } from "@hapsland/administration/rules/mcp/operations"
import { uncachedReviewSettingsLayer } from "@hapsland/review-definition/runtime/review-settings"
import { credentialResolverLayer } from "@hapsland/credential-storage/credentials/owner"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const body = (id: string, wording: string) =>
  JSON.stringify(
    {
      version: 1,
      id,
      question: wording,
      criteria: {
        false: "Empty input has a declared result or nonempty input is required",
        true: "Admitted empty input throws instead of returning its declared result"
      },
      message: "Express an admitted empty result. Nonempty inputs remain permitted.",
      inputs: [{ kind: "function", languages: ["typescript"], requires: ["signature", "body"] }]
    },
    null,
    2
  ) + "\n"
const fixture = async () => {
  const root = await makeGitFixture()
  const profile = await makeGitFixture()
  roots.push(root, profile)
  const user = join(profile, "config.jsonc")
  const personal = body("personal/totality", "Does an admitted input throw instead of returning a declared result?")
  const existing = body("project/original", "Does a head function exclude empty input in its declared input?")
  await put(profile, "personal.jsonc", personal)
  await put(
    profile,
    "config.jsonc",
    JSON.stringify({ version: 1, rules: [{ path: "personal.jsonc", excludes: ["fixtures/**"] }] })
  )
  await put(root, "project.jsonc", existing)
  await put(
    root,
    ".hapsland.jsonc",
    JSON.stringify({
      version: 1,
      rules: [
        { path: "project.jsonc", includes: ["target.ts"] },
        { id: "personal/totality", threshold: 0.95 }
      ],
      credentialEnvVar: "RECONCILIATION_KEY"
    })
  )
  await put(
    root,
    "target.ts",
    "export function head(xs: number[]): number { if (!xs.length) throw new Error('empty'); return xs[0]! }\n"
  )
  return { root, profile, user, personal, existing }
}
type Changes = Parameters<typeof previewRules>[0]["changes"]
const proposal = () =>
  [
    {
      action: "replace" as const,
      scope: "project" as const,
      id: "project/original",
      path: "project.jsonc",
      content: body(
        "project/original",
        "Does an admitted empty head input throw? A nonempty input type is a valid exception."
      ),
      settings: { threshold: 0.8 }
    },
    {
      action: "create" as const,
      scope: "project" as const,
      path: ".hapsland/rules/custom/project%2Foptional-head.jsonc",
      content: body(
        "project/optional-head",
        "Does an admitted empty input throw instead of returning an explicitly optional head?"
      ),
      settings: { enabled: true, includes: ["target.ts"], threshold: 0.8 }
    },
    { action: "configure" as const, scope: "project" as const, id: "personal/totality", settings: { enabled: false } }
  ] as const
const configuration = (user: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ REVIEW_USER_CONFIG_PATH: user, RECONCILIATION_KEY: "fixture-only" })
  )
const preview = (root: string, user: string, changes: Changes) =>
  Effect.runPromise(
    previewRules({ repository: root, operation: "preview", changes }).pipe(Effect.provide(configuration(user)))
  )

it("previews and applies a replacement and distinct Project alternative with visible local disabling", async () => {
  const { root, profile, user, personal, existing } = await fixture()
  const changes = proposal()
  const inspected = await Effect.runPromise(
    inspectRules({ repository: root, operation: "inspect" }).pipe(Effect.provide(configuration(user)))
  )
  expect(inspected.rules.find((rule) => rule.id === "personal/totality")).toMatchObject({
    content: personal,
    enabled: true
  })
  const proposed = await preview(root, user, changes)
  expect(proposed.changes).toEqual(changes)
  expect(proposed.files).toMatchObject([
    { id: "project/original", before: existing, after: changes[0]!.content },
    { id: "project/optional-head", before: undefined }
  ])
  expect(proposed.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "personal/totality", enabled: false }),
      expect.objectContaining({ id: "project/original", threshold: 0.8 })
    ])
  )
  expect(await readFile(join(root, "project.jsonc"), "utf8")).toBe(existing)
  const saved = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(user))
    )
  )
  expect(saved).toMatchObject({
    status: "completed",
    files: [
      { saved: "exact", activation: "enabled" },
      { saved: "exact", activation: "enabled" }
    ],
    rules: [
      { id: "project/original", activation: "enabled" },
      { id: "project/optional-head", activation: "enabled" },
      { id: "personal/totality", activation: "disabled" }
    ]
  })
  expect(await readFile(join(profile, "personal.jsonc"), "utf8")).toBe(personal)
  expect(await readFile(join(root, "project.jsonc"), "utf8")).toBe(changes[0]!.content)
  const actual = await Effect.runPromise(
    inspectRules({ repository: root, operation: "inspect" }).pipe(Effect.provide(configuration(user)))
  )
  expect(actual.rules.find((rule) => rule.id === "personal/totality")).toMatchObject({
    enabled: false,
    filters: { excludes: ["fixtures/**"] }
  })
  expect(actual.rules.find((rule) => rule.id === "project/original")).toMatchObject({
    filters: { includes: ["target.ts"] },
    question: expect.stringContaining("nonempty input type")
  })
})

it.each(["different-file", "different-id", "personal-through-project", "project-through-personal"])(
  "rejects %s replacement authority before any write",
  async (scenario) => {
    const { root, profile, user, personal, existing } = await fixture()
    const proposed = await preview(root, user, proposal())
    const personalTarget = scenario === "personal-through-project"
    const wrong = {
      action: "replace" as const,
      scope: scenario === "project-through-personal" ? ("personal" as const) : ("project" as const),
      id: personalTarget ? "personal/totality" : "project/original",
      path: personalTarget || scenario === "different-file" ? join(profile, "personal.jsonc") : "project.jsonc",
      content: body(
        scenario === "different-id" ? "project/other" : personalTarget ? "personal/totality" : "project/original",
        "Changed requirement"
      ),
      settings: {}
    }
    const projectConfiguration = await readFile(join(root, ".hapsland.jsonc"), "utf8")
    const personalConfiguration = await readFile(user, "utf8")
    const result = await Effect.runPromise(
      applyRules({
        repository: root,
        operation: "apply",
        changes: [wrong],
        previewDigest: proposed.previewDigest
      }).pipe(Effect.provide(configuration(user)), Effect.result)
    )
    expect(result._tag).toBe("Failure")
    expect(await readFile(join(root, "project.jsonc"), "utf8")).toBe(existing)
    expect(await readFile(join(profile, "personal.jsonc"), "utf8")).toBe(personal)
    expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(projectConfiguration)
    expect(await readFile(user, "utf8")).toBe(personalConfiguration)
  }
)

it("rejects unauthorized directory destinations before attempting their content snapshots", async () => {
  const { root, user } = await fixture()
  const changes = proposal()
  for (const [change, reason] of [
    [{ ...changes[0], path: "." }, "replacement destination"],
    [{ ...changes[1], path: "." }, "authorized Project"]
  ] as const) {
    await expect(preview(root, user, [change])).rejects.toMatchObject({ reason: expect.stringContaining(reason) })
  }
})

const personalProposal = (profile: string): Changes => [
  {
    action: "replace",
    scope: "personal",
    id: "personal/totality",
    path: join(profile, "personal.jsonc"),
    content: body("personal/totality", "Does an admitted empty input throw? Nonempty input remains a valid exception."),
    settings: { threshold: 0.65 }
  },
  proposal()[1],
  proposal()[2]
]

it("creates an explicitly scoped Personal rule only at its authorized profile destination", async () => {
  const { root, profile, user } = await fixture()
  const changes: Changes = [
    {
      action: "create",
      scope: "personal",
      path: join(profile, "rules/custom/personal%2Fexplicit.jsonc"),
      content: body("personal/explicit", "Does an admitted empty input lack an explicit result?"),
      settings: { enabled: true }
    }
  ]
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const proposed = await preview(root, user, changes)
  expect(proposed.configurations).toMatchObject([{ scope: "personal", path: user }])
  const saved = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(user))
    )
  )
  expect(saved).toMatchObject({
    status: "completed",
    files: [{ scope: "personal", activation: "enabled", saved: "exact" }]
  })
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
})

it("shows explicit Personal replacement and local Project effects together while preserving other-project activation", async () => {
  const { root, profile, user } = await fixture()
  const other = await makeGitFixture()
  roots.push(other)
  await put(other, ".hapsland.jsonc", JSON.stringify({ version: 1, rules: [] }))
  const changes = personalProposal(profile)
  const proposed = await preview(root, user, changes)
  expect(proposed.configurations.map((effect) => effect.scope)).toEqual(["personal", "project"])
  expect(proposed.affectedRules.find((rule) => rule.id === "personal/totality")).toMatchObject({
    before: { enabled: true, threshold: 0.95 },
    after: { enabled: false, threshold: 0.95 }
  })
  const saved = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(user))
    )
  )
  expect(saved).toMatchObject({
    status: "completed",
    configurations: [
      { scope: "personal", observed: "exact" },
      { scope: "project", observed: "exact" }
    ]
  })
  const otherState = await Effect.runPromise(
    inspectRules({ repository: other, operation: "inspect" }).pipe(Effect.provide(configuration(user)))
  )
  expect(otherState.rules.find((rule) => rule.id === "personal/totality")).toMatchObject({
    enabled: true,
    threshold: 0.65,
    question: expect.stringContaining("Nonempty input remains"),
    filters: { excludes: ["fixtures/**"] }
  })
})

it("holds every existing scoped mutation lock before a combined Personal/Project proposal writes", async () => {
  const { root, profile, user, personal } = await fixture()
  const changes = personalProposal(profile)
  const proposed = await preview(root, user, changes)
  const before = await readFile(join(root, ".hapsland.jsonc"), "utf8")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        withInstallationLock(
          `${user}.rules-lock`,
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined)
            yield* Deferred.await(release)
          })
        )
      )
      yield* Deferred.await(acquired)
      const attempted = yield* applyRules({
        repository: root,
        operation: "apply",
        changes,
        previewDigest: proposed.previewDigest
      }).pipe(Effect.result)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      return attempted
    }).pipe(Effect.provide(configuration(user)))
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: expect.stringContaining("lock remained busy") } })
  expect(await readFile(join(profile, "personal.jsonc"), "utf8")).toBe(personal)
  expect(await readFile(join(root, ".hapsland.jsonc"), "utf8")).toBe(before)
})

it("reports a real combined partial write, inspects it and requires a renewed preview before repair", async () => {
  const { root, user, existing } = await fixture()
  const changes = proposal()
  const proposed = await preview(root, user, changes)
  const deniedDirectory = join(root, ".hapsland/rules/custom")
  await mkdir(deniedDirectory, { recursive: true })
  const originalMode = (await stat(deniedDirectory)).mode & 0o777
  let result: Effect.Success<ReturnType<typeof applyRules>> | undefined
  try {
    await chmod(deniedDirectory, 0o500)
    result = await Effect.runPromise(
      applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
        Effect.provide(configuration(user))
      )
    )
  } finally {
    await chmod(deniedDirectory, originalMode)
  }
  expect(result).toMatchObject({
    status: "partial",
    files: [
      { saved: "exact", write: "completed", activation: "enabled" },
      { saved: "absent", write: "incomplete", activation: "not-connected" }
    ],
    configurations: [{ observed: "different", write: "incomplete" }],
    rules: expect.arrayContaining([
      expect.objectContaining({ id: "personal/totality", activation: "enabled", expectedEnabled: false })
    ])
  })
  expect(await readFile(join(root, "project.jsonc"), "utf8")).not.toBe(existing)
  const inspected = await Effect.runPromise(
    inspectRules({ repository: root, operation: "inspect" }).pipe(Effect.provide(configuration(user)))
  )
  expect(inspected.rules.find((rule) => rule.id === "project/original")).toMatchObject({
    question: expect.stringContaining("nonempty input type")
  })
  expect(inspected.rules.find((rule) => rule.id === "personal/totality")).toMatchObject({ enabled: true })
  await expect(
    Effect.runPromise(
      applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
        Effect.provide(configuration(user))
      )
    )
  ).rejects.toMatchObject({ reason: expect.stringContaining("stale or changed") })
  const renewed = await preview(root, user, changes)
  expect(renewed.previewDigest).not.toBe(proposed.previewDigest)
  const repaired = await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes, previewDigest: renewed.previewDigest }).pipe(
      Effect.provide(configuration(user))
    )
  )
  expect(repaired.status).toBe("completed")
})

it("binds ordered reconciled changes and snapshots so stale or reordered proposals write nothing", async () => {
  const { root, user, existing } = await fixture()
  const changes = proposal()
  const proposed = await preview(root, user, changes)
  const reversed = [...changes].reverse()
  await expect(
    Effect.runPromise(
      applyRules({
        repository: root,
        operation: "apply",
        changes: reversed,
        previewDigest: proposed.previewDigest
      }).pipe(Effect.provide(configuration(user)))
    )
  ).rejects.toMatchObject({ reason: expect.stringContaining("stale or changed") })
  expect(await readFile(join(root, "project.jsonc"), "utf8")).toBe(existing)
  await put(root, "project.jsonc", existing + "\n// External operator edit\n")
  await expect(
    Effect.runPromise(
      applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
        Effect.provide(configuration(user))
      )
    )
  ).rejects.toMatchObject({ reason: expect.stringContaining("stale or changed") })
  expect(await readFile(join(root, "project.jsonc"), "utf8")).toBe(existing + "\n// External operator edit\n")
})

it("checks every reconciled candidate through canonical rule aliases identically before and after application", async () => {
  const { root, user } = await fixture()
  await symlink("project.jsonc", join(root, "project-alias.jsonc"))
  await put(
    root,
    ".hapsland.jsonc",
    JSON.stringify({
      version: 1,
      rules: [
        { path: "project-alias.jsonc", includes: ["target.ts"] },
        { id: "personal/totality", threshold: 0.95 }
      ],
      credentialEnvVar: "RECONCILIATION_KEY"
    })
  )
  const changes = proposal().map((change) =>
    change.action === "replace" ? { ...change, path: "project-alias.jsonc" } : change
  )
  const proposed = await preview(root, user, changes)
  let probability = 0.9
  const requests: string[] = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "")
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          model: "jev-latest",
          answers: {
            "project/original": { type: "noul", noul: probability },
            "project/optional-head": { type: "noul", noul: probability }
          },
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })
  )
  const dependencies = Layer.mergeAll(
    uncachedReviewSettingsLayer,
    credentialResolverLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    configuration(user)
  )
  const targets = [{ path: "target.ts", line: 1 }]
  const candidate = await Effect.runPromise(
    checkRules({ repository: root, mode: "candidate", changes, previewDigest: proposed.previewDigest, targets }).pipe(
      Effect.provide(dependencies)
    )
  )
  expect(candidate.outcomes[0]).toMatchObject({
    status: "evaluated",
    results: [
      { ruleId: "project/original", finding: true },
      { ruleId: "project/optional-head", finding: true }
    ]
  })
  expect(requests[0]).toContain("A nonempty input type is a valid exception")
  await Effect.runPromise(
    applyRules({ repository: root, operation: "apply", changes, previewDigest: proposed.previewDigest }).pipe(
      Effect.provide(configuration(user))
    )
  )
  const applied = await Effect.runPromise(
    checkRules({ repository: root, mode: "stored", targets }).pipe(Effect.provide(dependencies))
  )
  expect(applied.outcomes[0]).toEqual(candidate.outcomes[0])
  expect(requests[1]).toBe(requests[0])
  await put(root, "target.ts", "export function head(xs: number[]): number | undefined { return xs[0] }\n")
  probability = 0.1
  const repaired = await Effect.runPromise(
    checkRules({ repository: root, mode: "stored", targets }).pipe(Effect.provide(dependencies))
  )
  expect(repaired.outcomes[0]).toMatchObject({
    status: "evaluated",
    results: [
      { ruleId: "project/original", finding: false },
      { ruleId: "project/optional-head", finding: false }
    ]
  })
  expect(requests).toHaveLength(3)
  expect(requests[2]).not.toBe(requests[1])
})
