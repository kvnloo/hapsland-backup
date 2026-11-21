import { BUN_VERSION, bunExecutable } from "@hapsland/runtime-environment/runtime/bun-runtime"
import {
  emittedReleaseEntrypoints,
  packageAssetPath,
  packageRootFromEntrypoint
} from "@hapsland/runtime-environment/runtime/package-runtime"
import { createInstallationPackageFixture } from "@hapsland/build-tooling/test-support/installation-package"
import { ConfigProvider, Effect } from "effect"
import { createHash } from "node:crypto"
import { canonicalJson } from "@hapsland/administration/onboarding/hook-reconciliation"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  diagnoseClaudeIntegration,
  inspectClaudeInstallation,
  installClaudeIntegration,
  previewClaudeInstallation,
  previewClaudeUpdate,
  uninstallClaudeIntegration,
  updateClaudeIntegration
} from "@hapsland/administration/onboarding/claude-installation"

const testConfiguration = () => ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))
const runPreview = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testConfiguration())))
const runInstallation = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testConfiguration())))

const roots: string[] = []
afterEach(() => {
  delete process.env.REVIEW_INSTALL_RUNTIME
  delete process.env.REVIEW_INSTALL_ENTRYPOINT
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = (version = "2.1.218") => {
  const root = mkdtempSync(join(tmpdir(), "claude installation ' "))
  roots.push(root)
  const home = join(root, "custom .claude")
  mkdirSync(home)
  const claudeExecutable = join(root, "claude fake")
  writeFileSync(claudeExecutable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  chmodSync(claudeExecutable, 0o700)
  const entrypoint = join(root, "cli.js")
  writeFileSync(entrypoint, "process.stdin.resume();\n")
  process.env.REVIEW_INSTALL_RUNTIME = bunExecutable()
  process.env.REVIEW_INSTALL_ENTRYPOINT = entrypoint
  return { root, home, claudeExecutable }
}

const mcpFixture = () => {
  const selected = fixture("2.1.330")
  const entrypoint = createInstallationPackageFixture(selected.root)
  const targetRoot = packageRootFromEntrypoint(entrypoint)
  const cli = join(targetRoot, emittedReleaseEntrypoints.cli)
  mkdirSync(join(cli, ".."), { recursive: true })
  writeFileSync(cli, "process.stdin.resume();\n")
  const skill = join(targetRoot, "skills", "hapsland-rule-authoring", "SKILL.md")
  mkdirSync(join(skill, ".."), { recursive: true })
  writeFileSync(skill, readFileSync(packageAssetPath("skills", "hapsland-rule-authoring", "SKILL.md"), "utf8"))
  process.env.REVIEW_INSTALL_ENTRYPOINT = entrypoint
  return { ...selected, entrypoint, targetRoot, cli, skill }
}

const settings = (home: string) =>
  JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>
const digestOf = (preview: object) => {
  const proposal = (preview as { proposal?: { digest: string } }).proposal
  expect(proposal?.digest).toMatch(/^[a-f0-9]{64}$/)
  return proposal!.digest
}

describe("Claude installation lifecycle", () => {
  it("binds MCP command and canonical skill to the same explicitly selected package as hooks", async () => {
    const { home, claudeExecutable, cli, skill } = mcpFixture()
    const targetSkill = `${readFileSync(skill, "utf8")}\n<!-- selected retained target -->\n`
    writeFileSync(skill, targetSkill)
    const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
    const preview = await runPreview(previewClaudeInstallation(request))
    expect(
      await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))
    ).toMatchObject({ status: "complete" })
    const installed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.hapsland
    expect(installed).toMatchObject({ command: bunExecutable(), args: [cli, "mcp"] })
    expect(readFileSync(join(home, "skills", "hapsland-rule-authoring", "SKILL.md"), "utf8")).toBe(targetSkill)
  })

  it("removes owned MCP artifacts when the selected target assets are missing", async () => {
    const { home, claudeExecutable, cli, skill } = mcpFixture()
    const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
    const initial = await runPreview(previewClaudeInstallation(request))
    await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(initial) }))
    rmSync(cli)
    rmSync(skill)
    const removal = await runInstallation(uninstallClaudeIntegration(request))
    expect(
      await runInstallation(uninstallClaudeIntegration({ ...request, proposalDigest: digestOf(removal) }))
    ).toMatchObject({ status: "complete" })
    expect(existsSync(join(home, "skills", "hapsland-rule-authoring", "SKILL.md"))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({})
  })

  it.each(["entry", "skill"])("preserves an unowned Hapsland-named %s instead of adopting it", async (artifact) => {
    const { home, claudeExecutable } = mcpFixture()
    const path =
      artifact === "entry" ? join(home, ".claude.json") : join(home, "skills", "hapsland-rule-authoring", "SKILL.md")
    mkdirSync(join(path, ".."), { recursive: true })
    const content =
      artifact === "entry"
        ? JSON.stringify({ mcpServers: { hapsland: { type: "stdio", command: "operator-server", args: [] } } })
        : "operator-owned skill\n"
    writeFileSync(path, content)
    expect(
      await runPreview(
        previewClaudeInstallation({ claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } })
      )
    ).toMatchObject({ status: "conflict" })
    expect(readFileSync(path, "utf8")).toBe(content)
    expect(existsSync(join(home, ".hapsland", "claude-installation-v1.json"))).toBe(false)
  })

  it("installs MCP and its canonical skill without adding hooks", async () => {
    const { home, claudeExecutable } = mcpFixture()
    const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
    const preview = await runPreview(previewClaudeInstallation(request))
    expect(preview.status).toBe("preview")
    expect(existsSync(join(home, ".claude.json"))).toBe(false)
    expect(
      await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))
    ).toMatchObject({ status: "complete", restart: { required: true } })
    expect(existsSync(join(home, "settings.json"))).toBe(false)
    const registration = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))
    expect(registration.mcpServers.hapsland).toMatchObject({ type: "stdio", args: expect.arrayContaining(["mcp"]) })
    expect(readFileSync(join(home, "skills", "hapsland-rule-authoring", "SKILL.md"), "utf8")).toBe(
      readFileSync(packageAssetPath("skills", "hapsland-rule-authoring", "SKILL.md"), "utf8")
    )
    expect(await runInstallation(inspectClaudeInstallation(request))).toMatchObject({ installed: true })
  })

  it("targets the Claude profile selected by the caller configuration", async () => {
    const { home, claudeExecutable, entrypoint } = mcpFixture()
    const preview = await Effect.runPromise(
      previewClaudeInstallation({ claudeExecutable, integrations: { hooks: false, mcp: true } }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLAUDE_CONFIG_DIR: home,
              REVIEW_INSTALL_RUNTIME: bunExecutable(),
              REVIEW_INSTALL_ENTRYPOINT: entrypoint
            })
          )
        )
      )
    )
    expect(preview).toMatchObject({ status: "preview", host: { home } })
    expect("proposal" in preview && preview.proposal.changes.map((change) => change.path)).toContain(
      join(home, ".claude.json")
    )
  })

  it.skipIf(process.platform === "win32")(
    "refuses a substituted skill directory before planning profile writes",
    async () => {
      const { root, home, claudeExecutable } = mcpFixture()
      const foreign = join(root, "foreign-skills")
      mkdirSync(foreign)
      symlinkSync(foreign, join(home, "skills"), "dir")
      const preview = await runPreview(
        previewClaudeInstallation({ claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } })
      )
      expect(preview).toMatchObject({
        status: "conflict",
        error: { message: expect.stringMatching(/skill.*directory/i) }
      })
      expect(existsSync(join(foreign, "hapsland-rule-authoring"))).toBe(false)
      expect(existsSync(join(home, ".hapsland"))).toBe(false)
    }
  )

  it("preserves unrelated profile state across MCP update, missing-file repair and removal", async () => {
    const { home, claudeExecutable } = mcpFixture()
    const hookSettings = JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other-hook" }] }] }
    })
    const unrelated = {
      migrationMarker: "retained",
      mcpServers: { other: { type: "stdio", command: "other-server", args: [] } }
    }
    const mcpPath = join(home, ".claude.json")
    const skillPath = join(home, "skills", "hapsland-rule-authoring", "SKILL.md")
    writeFileSync(join(home, "settings.json"), hookSettings)
    writeFileSync(mcpPath, JSON.stringify(unrelated))
    const request = { claudeHome: home, claudeExecutable }
    const installation = { ...request, integrations: { hooks: false, mcp: true } }
    const initial = await runPreview(previewClaudeInstallation(installation))
    expect(
      await runInstallation(installClaudeIntegration({ ...installation, proposalDigest: digestOf(initial) }))
    ).toMatchObject({ status: "complete" })
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(hookSettings)
    expect(await runPreview(previewClaudeUpdate(request))).toMatchObject({
      alreadyCurrent: true,
      integrations: { hooks: false, mcp: true },
      proposal: { changes: [] }
    })

    rmSync(skillPath)
    writeFileSync(mcpPath, JSON.stringify(unrelated))
    expect(await runInstallation(inspectClaudeInstallation(request))).toMatchObject({ status: "conflict" })
    const repair = await runPreview(previewClaudeUpdate(request))
    expect(
      await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(repair) }))
    ).toMatchObject({ status: "complete" })
    expect(await runInstallation(inspectClaudeInstallation(request))).toMatchObject({
      status: "ready",
      installed: true
    })
    expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toMatchObject(unrelated)

    const removal = await runInstallation(uninstallClaudeIntegration(request))
    expect(
      await runInstallation(uninstallClaudeIntegration({ ...request, proposalDigest: digestOf(removal) }))
    ).toMatchObject({ status: "complete" })
    expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toEqual(unrelated)
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(hookSettings)
    expect(existsSync(skillPath)).toBe(false)
    expect(existsSync(join(home, ".hapsland", "claude-installation-v1.json"))).toBe(false)
  })

  it.each(["skill", "entry"])(
    "preserves a locally modified owned MCP %s during update and removal",
    async (artifact) => {
      const { home, claudeExecutable } = mcpFixture()
      const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
      const initial = await runPreview(previewClaudeInstallation(request))
      await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(initial) }))
      const mcpPath = join(home, ".claude.json")
      const skillPath = join(home, "skills", "hapsland-rule-authoring", "SKILL.md")
      if (artifact === "skill") writeFileSync(skillPath, "operator-edited skill\n")
      else {
        const configuration = JSON.parse(readFileSync(mcpPath, "utf8"))
        configuration.mcpServers.hapsland.args.push("operator-change")
        writeFileSync(mcpPath, JSON.stringify(configuration))
      }
      const before = [mcpPath, skillPath].map((path) => readFileSync(path, "utf8"))
      expect(await runPreview(previewClaudeUpdate(request))).toMatchObject({ status: "conflict" })
      expect(await runInstallation(uninstallClaudeIntegration(request))).toMatchObject({ status: "conflict" })
      expect([mcpPath, skillPath].map((path) => readFileSync(path, "utf8"))).toEqual(before)
      expect(await runPreview(previewClaudeInstallation({ ...request, reinstall: true }))).toMatchObject({
        status: "conflict"
      })
    }
  )

  it("changes explicit integration selection while preserving unrelated hooks", async () => {
    const { home, claudeExecutable } = mcpFixture()
    const unrelated = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-hook" }] }] } }
    writeFileSync(join(home, "settings.json"), JSON.stringify(unrelated))
    const request = { claudeHome: home, claudeExecutable }
    const both = { ...request, integrations: { hooks: true, mcp: true } }
    const initial = await runPreview(previewClaudeInstallation(both))
    await runInstallation(installClaudeIntegration({ ...both, proposalDigest: digestOf(initial) }))
    expect(JSON.stringify(settings(home))).toContain("--review-tool-owned=claude-v1")
    const mcpOnly = { ...request, integrations: { hooks: false, mcp: true } }
    const first = await runPreview(previewClaudeUpdate(mcpOnly))
    expect(
      await runInstallation(updateClaudeIntegration({ ...mcpOnly, proposalDigest: digestOf(first) }))
    ).toMatchObject({ status: "complete" })
    expect(settings(home)).toEqual(unrelated)
    expect(await runInstallation(inspectClaudeInstallation(request))).toMatchObject({
      installed: true,
      integrations: mcpOnly.integrations
    })
    const hooksOnly = { ...request, integrations: { hooks: true, mcp: false } }
    const second = await runPreview(previewClaudeUpdate(hooksOnly))
    expect(
      await runInstallation(updateClaudeIntegration({ ...hooksOnly, proposalDigest: digestOf(second) }))
    ).toMatchObject({ status: "complete" })
    expect(JSON.stringify(settings(home))).toContain("other-hook")
    expect(JSON.stringify(settings(home))).toContain("--review-tool-owned=claude-v1")
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({})
    expect(existsSync(join(home, "skills", "hapsland-rule-authoring", "SKILL.md"))).toBe(false)
  })

  it("rejects a preview after unrelated MCP configuration changes without writing owned artifacts", async () => {
    const { home, claudeExecutable } = mcpFixture()
    const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
    const preview = await runPreview(previewClaudeInstallation(request))
    const changed = JSON.stringify({ deviceMetadata: "changed after preview" })
    writeFileSync(join(home, ".claude.json"), changed)
    expect(
      await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))
    ).toMatchObject({ status: "proposal-mismatch" })
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(changed)
    expect(existsSync(join(home, "skills", "hapsland-rule-authoring", "SKILL.md"))).toBe(false)
    expect(existsSync(join(home, ".hapsland", "claude-installation-v1.json"))).toBe(false)
  })

  it("inspects an owned retained registration separately from an available MCP update", async () => {
    const { home, claudeExecutable } = mcpFixture()
    const request = { claudeHome: home, claudeExecutable, integrations: { hooks: false, mcp: true } }
    const initial = await runPreview(previewClaudeInstallation(request))
    await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(initial) }))
    const retained = { type: "stdio", command: "/bin/cat", args: [], env: {} }
    const configurationPath = join(home, ".claude.json")
    const recordPath = join(home, ".hapsland", "claude-installation-v1.json")
    const configuration = JSON.parse(readFileSync(configurationPath, "utf8"))
    configuration.mcpServers.hapsland = retained
    writeFileSync(configurationPath, JSON.stringify(configuration))
    const record = JSON.parse(readFileSync(recordPath, "utf8"))
    record.mcp.entry = retained
    writeFileSync(recordPath, JSON.stringify(record))
    expect(await runInstallation(inspectClaudeInstallation(request))).toMatchObject({
      status: "ready",
      installed: true
    })
    const update = await runPreview(previewClaudeUpdate(request))
    expect(update).toMatchObject({ status: "preview", alreadyCurrent: false })
    expect("proposal" in update && update.proposal.changes.map((change) => change.path)).toContain(configurationPath)
    expect(JSON.parse(readFileSync(configurationPath, "utf8")).mcpServers.hapsland).toEqual(retained)
  })

  it.each(["REVIEW_INSTALL_RUNTIME", "REVIEW_INSTALL_ENTRYPOINT"])(
    "rejects empty %s before installation writes",
    async (key) => {
      const { home, claudeExecutable } = fixture()
      const result = await Effect.runPromise(
        installClaudeIntegration({ claudeHome: home, claudeExecutable }).pipe(
          Effect.result,
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ [key]: "" }, { preserveEmptyStrings: true }))
          )
        )
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "Claude installation configuration is invalid" }
      })
      expect(existsSync(join(home, "settings.json"))).toBe(false)
      expect(existsSync(join(home, ".hapsland"))).toBe(false)
    }
  )

  it("uses caller configuration instead of ambient installation inputs", async () => {
    const { root, home, claudeExecutable } = fixture()
    process.env.REVIEW_INSTALL_RUNTIME = ""
    process.env.REVIEW_INSTALL_ENTRYPOINT = ""
    const preview = await Effect.runPromise(
      previewClaudeInstallation({ claudeHome: home, claudeExecutable }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(
              { REVIEW_INSTALL_RUNTIME: bunExecutable(), REVIEW_INSTALL_ENTRYPOINT: join(root, "cli.js") },
              { preserveEmptyStrings: true }
            )
          )
        )
      )
    )
    expect(preview.status).toBe("preview")
    expect(digestOf(preview)).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(join(home, "settings.json"))).toBe(false)
  })

  it("preserves an unowned Claude launcher instead of adopting it", async () => {
    const { home, claudeExecutable } = fixture()
    const launcherDirectory = join(home, ".hapsland")
    mkdirSync(launcherDirectory)
    const launcher = join(launcherDirectory, "claude-hook-launcher.sh")
    const original = "#!/bin/sh\necho user-managed\n"
    writeFileSync(launcher, original, { mode: 0o600 })

    expect(await runPreview(previewClaudeInstallation({ claudeHome: home, claudeExecutable }))).toMatchObject({
      status: "conflict",
      error: { message: "Claude hook launcher was locally modified or is not owned" }
    })
    expect(readFileSync(launcher, "utf8")).toBe(original)
    expect(existsSync(join(home, "settings.json"))).toBe(false)
    expect(existsSync(join(launcherDirectory, "claude-installation-v1.json"))).toBe(false)
  })

  it("previews a pinned host, preserves unrelated settings, and removes only its owned hook", async () => {
    const { home, claudeExecutable } = fixture()
    const original = {
      permissions: { allow: ["Read"] },
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
        Stop: [{ hooks: [{ type: "command", command: "stop-tool" }] }]
      }
    }
    writeFileSync(join(home, "settings.json"), JSON.stringify(original))
    const request = { claudeHome: home, claudeExecutable }
    const preview = await runPreview(previewClaudeInstallation(request))
    expect(preview.status).toBe("preview")
    expect(preview).not.toHaveProperty("sourceEgressAuthorized")
    expect(settings(home)).toEqual(original)
    expect(
      (await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))).status
    ).toBe("complete")
    const installed = settings(home)
    expect(installed.permissions).toEqual(original.permissions)
    const installedHooks = installed.hooks as typeof original.hooks & {
      PreToolUse: unknown[]
      UserPromptSubmit: unknown[]
      SubagentStop: unknown[]
    }
    expect(installedHooks.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(installedHooks.PreToolUse)).toContain("exec ")
    expect(JSON.stringify(installedHooks.PreToolUse)).toContain("--composed-before-edit-hook")
    expect(installedHooks.Stop[0]).toEqual(original.hooks.Stop[0])
    expect(installedHooks.Stop).toHaveLength(2)
    expect(JSON.stringify(installedHooks.Stop[1])).toContain("--composed-stop-hook")
    expect(JSON.stringify(installedHooks.UserPromptSubmit)).toContain("--composed-prompt-hook")
    expect(installedHooks.SubagentStop).toHaveLength(1)
    expect(JSON.stringify(installedHooks.SubagentStop)).toContain("--composed-stop-hook")
    const post = (installed.hooks as typeof original.hooks).PostToolUse
    expect(post[0]).toEqual(original.hooks.PostToolUse[0])
    expect(post).toHaveLength(2)
    expect(JSON.stringify(post[1])).toContain("--claude-hook")
    expect(JSON.stringify(post[1])).not.toContain("--composed-background-hook")
    expect(JSON.stringify(post[1])).not.toContain('"async":true')
    expect(JSON.stringify(post[1])).toContain("--review-tool-owned=claude-v1")
    expect(((await runPreview(inspectClaudeInstallation(request))) as { installed?: boolean }).installed).toBe(true)
    const removal = await runInstallation(uninstallClaudeIntegration(request))
    expect(removal.status).toBe("preview")
    expect(
      (await runInstallation(uninstallClaudeIntegration({ ...request, proposalDigest: digestOf(removal) }))).status
    ).toBe("complete")
    expect(settings(home)).toEqual(original)
    expect(((await runPreview(inspectClaudeInstallation(request))) as { installed?: boolean }).installed).toBe(false)
  })

  it("updates an older owned installation to add SubagentStop", async () => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    await runInstallation(
      installClaudeIntegration({
        ...request,
        proposalDigest: digestOf(await runPreview(previewClaudeInstallation(request)))
      })
    )
    const previous = settings(home)
    delete (previous.hooks as Record<string, unknown>).SubagentStop
    writeFileSync(join(home, "settings.json"), JSON.stringify(previous))
    const recordPath = join(home, ".hapsland", "claude-installation-v1.json")
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { composed: { subagentStopDigest?: string } }
    delete record.composed.subagentStopDigest
    writeFileSync(recordPath, JSON.stringify(record))
    const proposal = await runPreview(previewClaudeUpdate(request))
    expect(proposal.status).toBe("preview")
    expect(
      (await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(proposal) }))).status
    ).toBe("complete")
    expect((settings(home).hooks as Record<string, unknown>).SubagentStop).toBeDefined()
  })

  it("refuses malformed composed ownership without changing Claude settings", async () => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    const proposal = await runPreview(previewClaudeInstallation(request))
    await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(proposal) }))
    const settingsBefore = readFileSync(join(home, "settings.json"), "utf8")
    const recordPath = join(home, ".hapsland", "claude-installation-v1.json")
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { composed: Record<string, unknown> }
    record.composed.stopDigest = 42
    writeFileSync(recordPath, JSON.stringify(record))

    expect(await runPreview(inspectClaudeInstallation(request))).toMatchObject({
      status: "conflict",
      error: expect.objectContaining({ message: expect.stringContaining("unsupported shape") })
    })
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(settingsBefore)
  })

  it("updates an owned asynchronous PostToolUse group to synchronous delivery while preserving Stop", async () => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    await runInstallation(
      installClaudeIntegration({
        ...request,
        proposalDigest: digestOf(await runPreview(previewClaudeInstallation(request)))
      })
    )
    const previous = settings(home)
    const hooks = previous.hooks as Record<string, Array<{ hooks: unknown[] }>>
    const group = hooks.PostToolUse![0]!
    group.hooks.push({
      type: "command",
      command: "old-cli --composed-background-hook --composed-host=claude-code --review-tool-composed-owned=claude-v1",
      timeout: 25,
      async: true
    })
    writeFileSync(join(home, "settings.json"), JSON.stringify(previous))
    const recordPath = join(home, ".hapsland", "claude-installation-v1.json")
    const record = JSON.parse(readFileSync(recordPath, "utf8"))
    record.hookGroups.PostToolUse = group
    record.hookDigest = createHash("sha256").update(canonicalJson(group)).digest("hex")
    writeFileSync(recordPath, JSON.stringify(record))
    const proposal = await runPreview(previewClaudeUpdate(request))
    expect(proposal.status).toBe("preview")
    expect(
      (await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(proposal) }))).status
    ).toBe("complete")
    const updated = settings(home).hooks as typeof hooks
    expect(updated.PostToolUse![0]!.hooks).toHaveLength(1)
    expect(JSON.stringify(updated.PostToolUse)).not.toContain("--composed-background-hook")
    expect(updated.Stop).toEqual(hooks.Stop)
    expect(updated.SubagentStop).toEqual(hooks.SubagentStop)
    expect(await runPreview(inspectClaudeInstallation(request))).toMatchObject({ installed: true })
  })

  it("installs an untested stable Claude version and passes it to every hook", async () => {
    const { home, claudeExecutable } = fixture("2.1.293 (Claude Code)")
    const request = { claudeHome: home, claudeExecutable }
    const preview = await runPreview(previewClaudeInstallation(request))
    expect(preview.status).toBe("preview")
    expect(
      (await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))).status
    ).toBe("complete")
    const hooks = settings(home).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    for (const groups of Object.values(hooks))
      for (const group of groups)
        for (const hook of group.hooks) expect(hook.command).toContain("--claude-version=2.1.293")
    expect(
      (await runPreview(diagnoseClaudeIntegration(request))).checks.find((check) => check.stage === "host")?.status
    ).toBe("ready")
  })

  it("rejects malformed host versions and requires an approval digest", async () => {
    const { home, claudeExecutable } = fixture("invalid")
    const request = { claudeHome: home, claudeExecutable }
    expect((await runPreview(previewClaudeInstallation(request))).status).toBe("unsupported")
    expect(
      (await runInstallation(installClaudeIntegration({ ...request, proposalDigest: "0".repeat(64) }))).status
    ).toBe("unsupported")
    expect(((await runPreview(inspectClaudeInstallation(request))) as { installed?: boolean }).installed).toBe(false)
    expect(
      (await runPreview(diagnoseClaudeIntegration(request))).checks.find((check) => check.stage === "host")?.status
    ).toBe("unsupported")
  })

  it("detects concurrent settings edits and locally modified owned entries", async () => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    const proposal = await runPreview(previewClaudeInstallation(request))
    writeFileSync(join(home, "settings.json"), JSON.stringify({ custom: true }))
    expect(
      (await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(proposal) }))).status
    ).toBe("proposal-mismatch")
    const current = await runPreview(previewClaudeInstallation(request))
    expect(
      (await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(current) }))).status
    ).toBe("complete")
    const changed = settings(home)
    const hooks = (changed.hooks as { PostToolUse: Array<{ matcher: string }> }).PostToolUse
    hooks[0]!.matcher = "Write"
    writeFileSync(join(home, "settings.json"), JSON.stringify(changed))
    expect((await runPreview(inspectClaudeInstallation(request))).status).toBe("conflict")
    expect((await runInstallation(uninstallClaudeIntegration(request))).status).toBe("conflict")
    expect(settings(home)).toEqual(changed)
  })

  it.each(["Stop", "SubagentStop"] as const)("rejects a locally modified owned %s hook", async (event) => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    await runInstallation(
      installClaudeIntegration({
        ...request,
        proposalDigest: digestOf(await runPreview(previewClaudeInstallation(request)))
      })
    )
    const changed = settings(home)
    const stop = (changed.hooks as Record<typeof event, Array<{ hooks: Array<{ timeout: number }> }>>)[event]
    stop[0]!.hooks[0]!.timeout = 3
    writeFileSync(join(home, "settings.json"), JSON.stringify(changed))
    expect((await runPreview(inspectClaudeInstallation(request))).status).toBe("conflict")
    expect((await runInstallation(uninstallClaudeIntegration(request))).status).toBe("conflict")
  })

  it("updates only the owned hook and keeps host trust separate from source egress", async () => {
    const { home, claudeExecutable, root } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    const initial = await runPreview(previewClaudeInstallation(request))
    await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(initial) }))
    const replacement = join(root, "new-cli.js")
    writeFileSync(replacement, "process.stdin.resume();\n")
    process.env.REVIEW_INSTALL_ENTRYPOINT = replacement
    const preview = await runPreview(previewClaudeUpdate(request))
    expect(preview.status).toBe("preview")
    expect(
      (await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))).status
    ).toBe("complete")
    expect(JSON.stringify(settings(home))).toContain("new-cli.js")
    expect(((await runPreview(inspectClaudeInstallation(request))) as { installed?: boolean }).installed).toBe(true)
    const doctor = await runPreview(diagnoseClaudeIntegration(request))
    expect(doctor.providerCalls).toBe(0)
    expect(doctor.checks.find((check) => check.stage === "native-trust")?.status).toBe("unknown")
    expect(doctor.checks.find((check) => check.stage === "file-selection")?.status).toBe("unknown")
  })
})

it.each(["PostToolUse", "PreToolUse", "Stop", "SubagentStop", "UserPromptSubmit", "foreground"])(
  "repairs deleted Claude %s without losing user settings",
  async (missing) => {
    const { home, claudeExecutable } = fixture()
    const request = { claudeHome: home, claudeExecutable }
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, custom: 42 }))
    await runInstallation(
      installClaudeIntegration({
        ...request,
        proposalDigest: digestOf(await runPreview(previewClaudeInstallation(request)))
      })
    )
    const changed = settings(home) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>
      permissions: unknown
      custom: number
    }
    if (missing === "foreground") changed.hooks.PostToolUse![0]!.hooks.splice(0, 1)
    else delete changed.hooks[missing]
    writeFileSync(join(home, "settings.json"), JSON.stringify(changed))
    expect((await runPreview(inspectClaudeInstallation(request))).status).toBe("conflict")
    const proposal = await runPreview(previewClaudeUpdate(request))
    expect(proposal.status).toBe("preview")
    expect(
      (await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(proposal) }))).status
    ).toBe("complete")
    expect(await runPreview(inspectClaudeInstallation(request))).toMatchObject({ installed: true })
    expect(settings(home)).toMatchObject({ permissions: { allow: ["Read"] }, custom: 42 })
    expect(await runPreview(previewClaudeUpdate(request))).toMatchObject({
      alreadyCurrent: true,
      proposal: { changes: [] }
    })
  }
)

it("explicit Claude reinstall replaces changed and duplicate marked handlers while preserving independent handlers", async () => {
  const { home, claudeExecutable } = fixture()
  const request = { claudeHome: home, claudeExecutable }
  await runInstallation(
    installClaudeIntegration({
      ...request,
      proposalDigest: digestOf(await runPreview(previewClaudeInstallation(request)))
    })
  )
  const changed = settings(home) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>
  }
  changed.hooks.PostToolUse![0]!.hooks[0]!.timeout = 99
  changed.hooks.PostToolUse![0]!.hooks.push({ command: "independent-handler" })
  changed.hooks.Stop!.push(structuredClone(changed.hooks.Stop![0]!))
  writeFileSync(join(home, "settings.json"), JSON.stringify(changed))
  expect((await runPreview(previewClaudeUpdate(request))).status).toBe("conflict")
  const reinstall = { ...request, reinstall: true }
  const proposal = await runPreview(previewClaudeInstallation(reinstall))
  expect(
    (await runInstallation(installClaudeIntegration({ ...reinstall, proposalDigest: digestOf(proposal) }))).status
  ).toBe("complete")
  expect(await runPreview(inspectClaudeInstallation(request))).toMatchObject({ installed: true })
  expect(JSON.stringify(settings(home))).toContain("independent-handler")
  expect(JSON.stringify(settings(home))).not.toContain('"timeout":99')
})

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "rolls back a published record when settings cannot be written",
  async () => {
    const { home, claudeExecutable } = fixture()
    const settingsPath = join(home, "settings.json")
    const ownershipDirectory = join(home, ".hapsland")
    mkdirSync(ownershipDirectory, { mode: 0o700 })
    const original = JSON.stringify({ userSetting: "retained" })
    writeFileSync(settingsPath, original)
    const request = { claudeHome: home, claudeExecutable }
    const preview = await runPreview(previewClaudeInstallation(request))
    chmodSync(home, 0o500)
    try {
      const result = await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))
      expect(result.status).toBe("conflict")
      expect(readFileSync(settingsPath, "utf8")).toBe(original)
      expect(existsSync(join(ownershipDirectory, "claude-installation-v1.json"))).toBe(false)
    } finally {
      chmodSync(home, 0o700)
    }
  }
)

it("updates a published Claude implementation without rewriting native settings", async () => {
  const { root, home, claudeExecutable } = fixture()
  const binaryDirectory = join(root, "dist/bin/darwin-arm64")
  const captureDirectory = join(root, "native/prebuilt/darwin-arm64")
  mkdirSync(binaryDirectory, { recursive: true })
  mkdirSync(captureDirectory, { recursive: true })
  writeFileSync(join(captureDirectory, "capture-open"), "capture fixture")
  const standalone = (name: string, marker: string) => {
    const entrypoint = join(binaryDirectory, name)
    writeFileSync(entrypoint, `#!/bin/sh\nprintf '%s\\n' '${BUN_VERSION}'\n# ${marker}\n`, { mode: 0o700 })
    return entrypoint
  }
  const select = (entrypoint: string) => {
    process.env.REVIEW_INSTALL_RUNTIME = entrypoint
    process.env.REVIEW_INSTALL_ENTRYPOINT = entrypoint
  }
  select(standalone("hook-one", "one"))
  const request = { claudeHome: home, claudeExecutable }
  const initial = await runPreview(previewClaudeInstallation(request))
  expect(initial.status).toBe("preview")
  expect(
    await runInstallation(installClaudeIntegration({ ...request, proposalDigest: digestOf(initial) }))
  ).toMatchObject({ status: "complete" })
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings(home)))
  const before = readFileSync(join(home, "settings.json"), "utf8")
  const next = standalone("hook-two", "two")
  select(next)
  const preview = await runPreview(previewClaudeUpdate(request))
  expect(preview).toMatchObject({ status: "preview", trust: { status: "unchanged" } })
  expect(
    await runInstallation(updateClaudeIntegration({ ...request, proposalDigest: digestOf(preview) }))
  ).toMatchObject({ status: "complete", trust: { status: "unchanged" } })
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before)
  expect(readFileSync(join(home, ".hapsland/claude-hook-launcher.sh"), "utf8")).toContain("hook-two")
  select(standalone("hook-identical", "two"))
  expect(await runPreview(previewClaudeUpdate(request))).toMatchObject({
    alreadyCurrent: true,
    proposal: { changes: [] }
  })
})
