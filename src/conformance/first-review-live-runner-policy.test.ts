import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "../../scripts/test-harness/process.mjs"
import {
  requireCleanInstallationPreview,
  setupAuthorization,
  requireCreatedSetup,
  firstReviewLiveEnvironment
} from "../../scripts/first-review-live-runner-policy.mjs"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = fileURLToPath(new URL("../..", import.meta.url))
const runner = join(root, "scripts", "run-first-review-live-milestone.mjs")
describe("first-review live runner provenance policy", () => {
  it("strips ambient Hapsland test and installation selectors while preserving authorized live inputs", () => {
    const env = firstReviewLiveEnvironment(
      {
        PATH: "/tools",
        TYPESAFE_API_KEY: "synthetic",
        REVIEW_INSTALL_ENTRYPOINT: "/wrong",
        REVIEW_INSTALL_RUNTIME: "/wrong",
        REVIEW_INSTALL_CONTROLLED: "1",
        REVIEW_CONTROL_JSON: "{}",
        REVIEW_DEMO_TEST_SANDBOX_BYPASS: "1",
        BUN_OPTIONS: "wrong"
      },
      { HOME: "/private/fixture", CODEX_HOME: "/private/fixture/codex" }
    )
    expect(env).toEqual({
      PATH: "/tools",
      TYPESAFE_API_KEY: "synthetic",
      HOME: "/private/fixture",
      CODEX_HOME: "/private/fixture/codex"
    })
    expect(firstReviewLiveEnvironment({}, {}, true).REVIEW_DEMO_TEST_SANDBOX_BYPASS).toBe("1")
  })
  it("installs a private snapshot of reviewed archive bytes even if the caller archive changes", () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "live-archive-custody-")))
    roots.push(temporary)
    const authHome = join(temporary, "auth")
    const tempHome = join(temporary, "fixtures")
    const bin = join(temporary, "bin")
    for (const path of [authHome, tempHome, bin]) mkdirSync(path)
    writeFileSync(join(authHome, "auth.json"), "{}")
    const archive = join(temporary, "caller.tgz")
    const capture = join(temporary, "capture.json")
    const bytes = "reviewed archive snapshot"
    writeFileSync(archive, bytes)
    const expected = createHash("sha256").update(bytes).digest("hex")
    writeFileSync(
      join(bin, "npm"),
      `#!${process.execPath}\nconst fs=require('node:fs');const crypto=require('node:crypto');fs.writeFileSync(process.env.FIXTURE_ORIGINAL,'changed caller archive');const selected=process.argv.at(-1);fs.writeFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({samePath:selected===process.env.FIXTURE_ORIGINAL,hash:crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex')}));process.exit(1);\n`,
      { mode: 0o700 }
    )
    const result = spawnSync(
      process.execPath,
      [runner, "--live", `--archive=${archive}`, `--expected-sha256=${expected}`],
      {
        cwd: root,
        timeout: 10000,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: tempHome,
          REVIEW_LIVE_CODEX_HOME: authHome,
          FIXTURE_ORIGINAL: archive,
          FIXTURE_CAPTURE: capture
        }
      }
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({ samePath: false, hash: expected })
    expect(readdirSync(tempHome)).toEqual([])
  })
  it("does not create a fixture or require authentication without explicit live selection", async () => {
    const result = spawnSync(process.execPath, [runner], { timeout: 5000, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "not-run", providerCalls: 0 })
  })
  it("rejects wrong local archive bytes, preserves the source auth profile and removes its private copy", async () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "live-runner-test-")))
    roots.push(temporary)
    const authHome = join(temporary, "source-profile")
    const tempHome = join(temporary, "fixtures")
    mkdirSync(authHome)
    mkdirSync(tempHome)
    const auth = JSON.stringify({ synthetic: "not-a-credential" })
    writeFileSync(join(authHome, "auth.json"), auth)
    const archive = join(temporary, "reviewed.tgz")
    writeFileSync(archive, "different archive bytes")
    const result = spawnSync(
      process.execPath,
      [runner, "--live", `--archive=${archive}`, `--expected-sha256=${"a".repeat(64)}`],
      {
        cwd: root,
        env: { ...process.env, TMPDIR: tempHome, REVIEW_LIVE_CODEX_HOME: authHome },
        timeout: 10000,
        encoding: "utf8"
      }
    )
    expect(result.status).toBe(1)
    expect(readFileSync(join(authHome, "auth.json"), "utf8")).toBe(auth)
    expect(readdirSync(tempHome)).toEqual([])
    expect(result.stdout).not.toContain("not-a-credential")
  })
  it("requires both exact setup approvals and complete ordinary setup stages", () => {
    const actions = [
      { code: "approve-installation", authorization: { installProposalDigest: "a".repeat(64) } },
      { code: "approve-default-rules", authorization: { rulesProposalDigest: "b".repeat(64) } }
    ]
    expect(setupAuthorization({ actions })).toEqual({
      installProposalDigest: "a".repeat(64),
      rulesProposalDigest: "b".repeat(64)
    })
    expect(() => setupAuthorization({ actions: actions.slice(0, 1) })).toThrow()
    const stages = ["installation", "rules", "repository", "credential"].map((stage) => ({ stage, status: "complete" }))
    expect(() => requireCreatedSetup({ stages })).not.toThrow()
    expect(() => requireCreatedSetup({ stages: stages.slice(0, 3) })).toThrow()
  })
  it("rejects a pre-existing owned installation before treating it as fixture-owned", () => {
    expect(() =>
      requireCleanInstallationPreview({ status: "preview", installed: true, proposal: { digest: "a".repeat(64) } })
    ).toThrow(/clean Codex home/)
  })
})
