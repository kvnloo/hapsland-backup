import { afterEach, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import { credentialResolverLayer } from "@hapsland/credential-storage/credentials/owner"
import { uncachedReviewSettingsLayer } from "@hapsland/review-definition/runtime/review-settings"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Schema from "effect/Schema"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { once } from "node:events"
import { bunExecutable } from "@hapsland/runtime-environment/runtime/bun-runtime"
import { makeGitFixture, put } from "@hapsland/build-tooling/test-support/test-fixtures"
import { inspectRules, checkRules } from "@hapsland/administration/rules/mcp/operations"
import { rulesCommandLiveLayer } from "@hapsland/administration/rules/command"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async (id: string) => {
  const root = await makeGitFixture()
  roots.push(root)
  await put(
    root,
    "rule.json",
    JSON.stringify({
      version: 1,
      id,
      title: "An authored concern",
      question: "Does the type admit an invalid state?",
      criteria: { false: "Valid", true: "Invalid" },
      message: "Refine the domain",
      inputs: [{ kind: "type", languages: ["typescript"], requires: ["root-declaration"] }]
    })
  )
  await put(
    root,
    ".hapsland.jsonc",
    JSON.stringify({ version: 1, rules: ["rule.json"], credentialEnvVar: "MCP_MISSING_KEY" })
  )
  await put(root, "target.ts", "export interface Selected { value: string }\n")
  return root
}
const configuration = (root: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ REVIEW_USER_CONFIG_PATH: join(root, "missing-user.json"), MCP_MISSING_KEY: "" })
  )

it("inspects complete authored rules in explicitly selected physical repositories", async () => {
  const a = await fixture("a")
  const b = await fixture("b")
  for (const [root, id] of [
    [a, "a"],
    [b, "b"]
  ] as const) {
    const inventory = await Effect.runPromise(
      inspectRules({ repository: root, operation: "inspect" }).pipe(Effect.provide(configuration(root)))
    )
    expect(inventory).toMatchObject({
      repository: root,
      classifierCalls: 0,
      rules: [{ id, content: expect.stringContaining('"question"'), enabled: true, origin: { layer: "project" } }]
    })
  }
})

it("preserves unavailable and skipped checks with zero requests", async () => {
  const root = await fixture("a")
  const result = await Effect.runPromise(
    checkRules({
      repository: root,
      mode: "stored",
      targets: [
        { path: "target.ts", line: 1 },
        { path: "target.ts", line: 100 }
      ]
    }).pipe(Effect.provide(rulesCommandLiveLayer), Effect.provide(configuration(root)))
  )
  expect(result).toMatchObject({
    repository: root,
    classifierCalls: 0,
    outcomes: [
      { status: "unavailable", reason: "credential-missing", declaration: { name: "Selected" } },
      { status: "skipped" }
    ]
  })
  expect(result.outcomes.every((outcome) => outcome.results.length === 0)).toBe(true)
})

it.each([
  { targets: [] },
  { targets: [{ path: "../outside.ts", line: 1 }] },
  { targets: [{ path: "/absolute.ts", line: 1 }] },
  { targets: [{ path: "target.ts", line: 0 }] },
  { targets: Array.from({ length: 21 }, () => ({ path: "target.ts", line: 1 })) }
])("rejects malformed or unbounded targets without source review: %j", async ({ targets }) => {
  const root = await fixture("a")
  const result = await Effect.runPromise(
    checkRules({ repository: root, mode: "stored", targets }).pipe(
      Effect.provide(rulesCommandLiveLayer),
      Effect.provide(configuration(root)),
      Effect.result
    )
  )
  expect(result._tag).toBe("Failure")
})

it("serves exactly two MCP tools and explicitly routes A and B through one stdio process", async () => {
  const a = await fixture("a")
  const b = await fixture("b")
  const child = spawn(bunExecutable(), [join(process.cwd(), "packages/cli-entry/src/cli.ts"), "mcp"], {
    cwd: a,
    env: { ...process.env, HOME: a, REVIEW_USER_CONFIG_PATH: join(a, "missing-user.json"), MCP_MISSING_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"]
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    pending.get(message.id)?.resolve(message)
    pending.delete(message.id)
  })
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited: ${stderr}`))
    pending.clear()
  })
  let sequence = 0
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  try {
    expect(
      await call("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" }
      })
    ).toMatchObject({ result: { serverInfo: { name: "hapsland" } } })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")
    const listed = await call("tools/list", {})
    expect(listed).toMatchObject({ result: { tools: [{ name: "derive_rule" }, { name: "check_rules" }] } })
    expect(listed).toMatchObject({
      result: {
        tools: [
          {
            name: "derive_rule",
            inputSchema: {
              type: "object",
              anyOf: expect.arrayContaining([
                expect.objectContaining({
                  properties: expect.objectContaining({ changes: expect.objectContaining({ type: "array" }) })
                })
              ])
            }
          },
          {
            name: "check_rules",
            inputSchema: {
              type: "object",
              anyOf: expect.arrayContaining([
                expect.objectContaining({
                  properties: expect.objectContaining({
                    previewDigest: expect.objectContaining({ type: "string" }),
                    changes: expect.objectContaining({ type: "array" })
                  })
                })
              ])
            }
          }
        ]
      }
    })
    expect(JSON.stringify(listed)).toContain('"content"')
    expect(JSON.stringify(listed)).toContain('"settings"')
    expect(JSON.stringify(listed)).toContain('"threshold"')
    expect(JSON.stringify(listed)).toContain("Complete version-one JSONC")
    expect(JSON.stringify(listed)).toContain("criteria")
    for (const [root, id] of [
      [a, "a"],
      [b, "b"]
    ] as const) {
      const answer = await call("tools/call", {
        name: "derive_rule",
        arguments: { repository: root, operation: "inspect", id }
      })
      expect(JSON.stringify(answer)).toContain(root)
      expect(JSON.stringify(answer)).toContain(`\\"id\\":\\"${id}\\"`)
    }
    const rejected = await call("tools/call", { name: "derive_rule", arguments: { operation: "inspect" } })
    expect(rejected).toMatchObject({ result: { isError: true } })
    const check = await call("tools/call", {
      name: "check_rules",
      arguments: { repository: b, mode: "stored", targets: [{ path: "target.ts", line: 1 }] }
    })
    expect(JSON.stringify(check)).toContain("credential-missing")
    expect(JSON.stringify(check)).toContain(b)
    const changes = [
      {
        action: "create",
        scope: "project",
        path: ".hapsland/rules/custom/new-rule.jsonc",
        content: JSON.stringify({
          version: 1,
          id: "new-rule",
          question: "Invalid state?",
          criteria: { false: "Valid", true: "Invalid" },
          message: "Refine the type",
          inputs: [{ kind: "type", languages: ["typescript"], requires: ["root-declaration"] }]
        }),
        settings: { enabled: true, threshold: 0.8 }
      }
    ]
    const preview = await call("tools/call", {
      name: "derive_rule",
      arguments: { repository: b, operation: "preview", changes }
    })
    const decodePreview = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          structuredContent: Schema.Struct({ repository: Schema.String, previewDigest: Schema.String })
        })
      })
    )
    const decodedPreview = decodePreview(preview)
    expect(decodedPreview.result.structuredContent.repository).toBe(b)
    const candidate = await call("tools/call", {
      name: "check_rules",
      arguments: {
        repository: b,
        mode: "candidate",
        targets: [{ path: "target.ts", line: 1 }],
        changes,
        previewDigest: decodedPreview.result.structuredContent.previewDigest
      }
    })
    expect(JSON.stringify(candidate)).toContain("credential-missing")
    expect(JSON.stringify(candidate)).toContain(b)
    // This fixture establishes stdio mechanics, not human consent or successful candidate validation.
    const previewA = decodePreview(
      await call("tools/call", { name: "derive_rule", arguments: { repository: a, operation: "preview", changes } })
    )
    const invalidConsent = await call("tools/call", {
      name: "derive_rule",
      arguments: {
        repository: a,
        operation: "apply",
        changes,
        previewDigest: previewA.result.structuredContent.previewDigest,
        approved: true
      }
    })
    expect(invalidConsent).toMatchObject({ result: { isError: true } })
    const applied = await call("tools/call", {
      name: "derive_rule",
      arguments: {
        repository: a,
        operation: "apply",
        changes,
        previewDigest: previewA.result.structuredContent.previewDigest
      }
    })
    expect(applied).toMatchObject({
      result: {
        structuredContent: {
          repository: a,
          status: "completed",
          files: [{ id: "new-rule", saved: "exact", activation: "enabled" }],
          validation: "not-run"
        }
      }
    })
    const saved = await call("tools/call", {
      name: "derive_rule",
      arguments: { repository: a, operation: "inspect", id: "new-rule" }
    })
    expect(saved).toMatchObject({
      result: {
        structuredContent: {
          repository: a,
          rules: [{ id: "new-rule", enabled: true, content: changes[0]?.content, threshold: 0.8 }]
        }
      }
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    }
    lines.close()
  }
})

it("retains paid-request accounting and invalidates earlier judgments when a later target fails", async () => {
  const root = await fixture("a")
  let calls = 0
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++
      // The first result is current at completion; the second request invalidates it and makes subsequent configuration unavailable.
      if (calls === 2) yield* Effect.promise(() => put(root, ".hapsland.jsonc", "{ invalid"))
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          model: "jev-latest",
          answers: { a: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      )
    })
  )
  const result = await Effect.runPromise(
    checkRules({
      repository: root,
      mode: "stored",
      targets: [
        { path: "target.ts", line: 1 },
        { path: "target.ts", line: 1 },
        { path: "target.ts", line: 1 }
      ]
    }).pipe(
      Effect.provide(uncachedReviewSettingsLayer),
      Effect.provide(credentialResolverLayer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            REVIEW_USER_CONFIG_PATH: join(root, "missing-user.json"),
            MCP_MISSING_KEY: "fixture-only"
          })
        )
      )
    )
  )
  expect(calls).toBe(2)
  expect(result.classifierCalls).toBe(2)
  expect(result.outcomes).toHaveLength(3)
  expect(result.outcomes[0]).toMatchObject({
    status: "unavailable",
    reason: "stale-at-final-report",
    classifierCalls: 1,
    results: []
  })
  expect(result.outcomes[1]).toMatchObject({ status: "unavailable", reason: "stale", classifierCalls: 1, results: [] })
  expect(result.outcomes[2]).toMatchObject({ status: "unavailable", classifierCalls: 0, results: [] })
})
