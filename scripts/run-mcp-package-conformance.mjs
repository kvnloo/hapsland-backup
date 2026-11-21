import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync, spawnSync } from "./test-harness/process.mjs"
import { standaloneEnvironment } from "./test-harness/standalone-environment.mjs"

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
const archive = argument("--archive")
if (!archive) throw new Error("Supply the reviewed combined candidate with --archive=PATH; this check never builds")
const selectedHost = argument("--host")
if (selectedHost !== undefined && !["codex", "claude"].includes(selectedHost)) throw new Error("Unknown host")
const deadline = Date.now() + Number(argument("--timeout-ms") ?? 180_000)
if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("Invalid finite deadline")
const budget = () => {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("MCP package conformance deadline exceeded")
  return Math.min(15_000, remaining)
}
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "hapsland-mcp-package-")))
const checks = []
const checked = (name, condition) => {
  assert.ok(condition, name)
  checks.push(name)
}
const repository = (name) => {
  const root = join(temporary, name)
  mkdirSync(root)
  execFileSync("git", ["init", "--quiet", "--initial-branch=master", root], { timeout: budget() })
  writeFileSync(join(root, ".hapsland.jsonc"), JSON.stringify({ version: 1, rules: [] }))
  writeFileSync(join(root, "target.ts"), "export type Selection = { value: number }\n")
  return realpathSync(root)
}

const withStdioClient = async (entry, environment, operation) => {
  const child = spawn(entry.command, entry.args, {
    env: environment,
    cwd: entry.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  })
  const stop = () => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  const pending = new Map()
  let sequence = 0
  let buffer = ""
  let outputBytes = 0
  let diagnostics = ""
  let resolveClosed
  const closed = new Promise((accept) => {
    resolveClosed = accept
  })
  const failPending = () => {
    for (const request of pending.values()) request.reject(new Error("Installed MCP server exited before its response"))
    pending.clear()
  }
  const interrupted = () => {
    stop()
    failPending()
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  child.on("error", failPending)
  child.stdin.on("error", failPending)
  child.on("close", () => {
    failPending()
    resolveClosed()
  })
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString()
    if (diagnostics.length > 1_048_576) stop()
  })
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length
    if (outputBytes > 1_048_576) {
      stop()
      return
    }
    buffer += chunk.toString()
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          request.resolve(message)
        }
      } catch {
        stop()
      }
    }
  })
  const call = (method, params) =>
    new Promise((accept, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        stop()
        reject(new Error(`Installed MCP ${method} timed out`))
      }, budget())
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          accept(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  try {
    return await operation({
      call,
      notify: (method, params = {}) => child.stdin.write(`${JSON.stringify({ method, params })}\n`)
    })
  } finally {
    child.stdin.end()
    let timer
    const stopped = await Promise.race([
      closed.then(() => true),
      new Promise((accept) => {
        timer = setTimeout(() => accept(false), 2_000)
      })
    ])
    clearTimeout(timer)
    if (!stopped) {
      stop()
      await closed
    }
    stop()
    process.removeListener("SIGINT", interrupted)
    process.removeListener("SIGTERM", interrupted)
  }
}

const inspectServer = (entry, environment, repositories) =>
  withStdioClient({ ...entry, cwd: repositories[0] }, environment, async ({ call, notify }) => {
    const tool = async (name, args) => {
      const response = await call("tools/call", { name, arguments: args })
      checked(`installed ${name} success`, response.result?.isError !== true && response.error === undefined)
      return response.result.structuredContent
    }
    let classifierCalls = 0
    const initial = await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "hapsland-package-fixture", version: "1" }
    })
    checked("installed MCP initialization", initial.result?.serverInfo?.name === "hapsland")
    notify("notifications/initialized")
    const tools = await call("tools/list", {})
    checked(
      "exact installed MCP tool inventory",
      JSON.stringify(tools.result?.tools.map((value) => value.name)) === JSON.stringify(["derive_rule", "check_rules"])
    )
    for (const root of repositories) {
      const inspected = await tool("derive_rule", { operation: "inspect", repository: root })
      checked(
        "explicit installed repository inspection",
        inspected.repository === root && inspected.classifierCalls === 0
      )
      classifierCalls += inspected.classifierCalls
      const previewed = await tool("derive_rule", {
        operation: "preview",
        repository: root,
        changes: [
          {
            action: "create",
            scope: "project",
            path: ".hapsland/rules/custom/installed-case.jsonc",
            content: JSON.stringify({
              version: 1,
              id: "installed-case",
              question: "Does this type admit an invalid domain value?",
              criteria: { false: "Valid domain values", true: "Invalid domain values are admitted" },
              message: "Refine the domain type",
              inputs: [{ languages: ["typescript"], kind: "type", requires: ["root-declaration"] }]
            }),
            settings: { enabled: true }
          }
        ]
      })
      checked(
        "explicit installed repository preview without writes",
        previewed.repository === root &&
          /^[a-f0-9]{64}$/.test(previewed.previewDigest) &&
          !existsSync(join(root, ".hapsland", "rules"))
      )
      const outcome = await tool("check_rules", {
        mode: "stored",
        repository: root,
        targets: [{ path: "target.ts", line: 1 }]
      })
      checked(
        "installed empty rule selection is incomplete",
        outcome.repository === root &&
          outcome.classifierCalls === 0 &&
          outcome.outcomes.every((value) => value.status === "skipped")
      )
      classifierCalls += outcome.classifierCalls
    }
    return classifierCalls
  })

const inspectCodexSkills = (environment, repository, skillPath) =>
  withStdioClient(
    { command: "codex", args: ["app-server", "--stdio"], cwd: repository },
    environment,
    async ({ call, notify }) => {
      const initial = await call("initialize", {
        clientInfo: { name: "hapsland-installation-probe", version: "1" },
        capabilities: null
      })
      checked("Codex discovery initialization", initial.error === undefined)
      notify("initialized")
      const response = await call("skills/list", { cwds: [repository], forceReload: true })
      checked(
        "Codex canonical skill native discovery",
        response.result?.data
          ?.flatMap((value) => value.skills)
          .some(
            (skill) =>
              skill.name === "hapsland-rule-authoring" &&
              skill.path === skillPath &&
              skill.scope === "user" &&
              skill.enabled === true
          )
      )
    }
  )

try {
  execFileSync("tar", ["-xzf", resolve(archive), "-C", temporary], { timeout: budget() })
  const packageRoot = join(temporary, "package")
  const cli = join(packageRoot, "dist", "bin", `${process.platform}-${process.arch}`, "hapsland")
  const canonicalSkill = readFileSync(join(packageRoot, "skills", "hapsland-rule-authoring", "SKILL.md"), "utf8")
  const userConfiguration = join(temporary, "user.jsonc")
  writeFileSync(userConfiguration, JSON.stringify({ version: 1, rules: [] }))
  const baseEnvironment = standaloneEnvironment(
    join(temporary, "standalone-path"),
    { ...process.env, HOME: temporary, REVIEW_USER_CONFIG_PATH: userConfiguration, HAPSLAND_ACTIVE_DISPATCH: "1" },
    ["codex", "claude"]
  )
  delete baseEnvironment.REVIEW_INSTALL_ENTRYPOINT
  delete baseEnvironment.REVIEW_INSTALL_RUNTIME
  const repositories = [repository("repository-a"), repository("repository-b")]
  const observedHosts = []
  let classifierCalls = 0
  for (const host of selectedHost === undefined ? ["codex", "claude"] : [selectedHost]) {
    const home = join(temporary, `${host}-profile`)
    mkdirSync(home)
    const environment = { ...baseEnvironment, [host === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: home }
    const fields =
      host === "codex"
        ? { host, codexHome: home, codexExecutable: "codex" }
        : { host, claudeHome: home, claudeExecutable: "claude" }
    const observedVersion = execFileSync(host, ["--version"], {
      cwd: repositories[0],
      env: environment,
      encoding: "utf8",
      timeout: budget()
    }).trim()
    observedHosts.push({ host, version: observedVersion })
    const configPath = join(home, host === "codex" ? "config.toml" : ".claude.json")
    const unrelated =
      host === "codex"
        ? 'user_note = "preserved"\n[mcp_servers.other]\ncommand = "/bin/cat"\nargs = []\n'
        : JSON.stringify({
            migrationMarker: "preserved",
            mcpServers: { other: { type: "stdio", command: "/bin/cat", args: [] } }
          })
    writeFileSync(configPath, unrelated)
    const hooksPath = join(home, host === "codex" ? "hooks.json" : "settings.json")
    const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other-hook" }] }] } })
    writeFileSync(hooksPath, hooks)
    const operation = (name, extra = {}) => {
      const response = spawnSync(cli, [`--${name}`], {
        cwd: repositories[0],
        env: environment,
        encoding: "utf8",
        input: JSON.stringify({ version: 1, operation: name, ...fields, ...extra }),
        timeout: budget(),
        maxBuffer: 1_048_576
      })
      checked(`${host} packaged ${name} terminated`, response.signal === null && !response.error)
      return JSON.parse(response.stdout)
    }
    const successStatus = (kind) =>
      host === "claude" ? "complete" : { install: "installed", update: "updated", uninstall: "uninstalled" }[kind]
    const preview = operation("install-preview", { integrations: { hooks: false, mcp: true } })
    checked(`${host} MCP-only preview`, preview.status === "preview")
    checked(
      `${host} MCP-only installation`,
      operation("install", { integrations: { hooks: false, mcp: true }, proposalDigest: preview.proposal.digest })
        .status === successStatus("install")
    )
    const skillPath = join(home, "skills", "hapsland-rule-authoring", "SKILL.md")
    checked(`${host} canonical installed skill`, readFileSync(skillPath, "utf8") === canonicalSkill)
    checked(`${host} independent hooks unchanged`, readFileSync(hooksPath, "utf8") === hooks)
    let entry
    if (host === "codex") {
      const registration = JSON.parse(
        execFileSync(host, ["mcp", "get", "hapsland", "--json"], {
          cwd: repositories[0],
          env: environment,
          encoding: "utf8",
          timeout: budget()
        })
      )
      entry = registration.transport
      checked("Codex user-profile MCP discovery", registration.name === "hapsland" && entry.type === "stdio")
      checked(
        "Codex forwards the user configuration selector by name",
        JSON.stringify(entry.env_vars) === JSON.stringify(["REVIEW_USER_CONFIG_PATH"]) &&
          !readFileSync(configPath, "utf8").includes(userConfiguration)
      )
      await inspectCodexSkills(environment, repositories[0], skillPath)
    } else {
      entry = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.hapsland
      const registration = execFileSync(host, ["mcp", "get", "hapsland"], {
        cwd: repositories[0],
        env: environment,
        encoding: "utf8",
        timeout: budget()
      })
      checked(
        "Claude user-profile MCP discovery",
        registration.includes("Scope: User config") &&
          registration.includes(entry.command) &&
          !registration.includes("Failed to connect")
      )
    }
    checked(
      `${host} retained standalone MCP command`,
      entry.command === cli && JSON.stringify(entry.args) === JSON.stringify(["mcp"])
    )
    classifierCalls += await inspectServer(entry, environment, repositories)
    const current = operation("update-preview")
    checked(
      `${host} omitted selection preserves MCP-only`,
      current.status === "preview" && current.alreadyCurrent === true
    )
    rmSync(skillPath)
    const repair = operation("update-preview")
    checked(
      `${host} missing skill repair`,
      repair.status === "preview" &&
        operation("update", { proposalDigest: repair.proposal.digest }).status === successStatus("update") &&
        readFileSync(skillPath, "utf8") === canonicalSkill
    )
    writeFileSync(skillPath, "operator modification\n")
    checked(`${host} modified skill update conflict`, operation("update-preview").status === "conflict")
    checked(`${host} modified skill removal conflict`, operation("uninstall").status === "conflict")
    checked(`${host} modified skill preserved`, readFileSync(skillPath, "utf8") === "operator modification\n")
    writeFileSync(skillPath, canonicalSkill)
    const removal = operation("uninstall")
    checked(`${host} removal preview`, removal.status === "preview")
    checked(
      `${host} owned removal`,
      operation("uninstall", { proposalDigest: removal.proposal.digest }).status === successStatus("uninstall")
    )
    checked(`${host} unrelated hooks survive removal`, readFileSync(hooksPath, "utf8") === hooks)
    const remaining = readFileSync(configPath, "utf8")
    const unrelatedSurvived =
      host === "claude"
        ? (() => {
            const configuration = JSON.parse(remaining)
            return (
              configuration.migrationMarker === "preserved" &&
              configuration.mcpServers.other.command === "/bin/cat" &&
              configuration.mcpServers.hapsland === undefined
            )
          })()
        : JSON.parse(
            execFileSync(host, ["mcp", "get", "other", "--json"], {
              cwd: repositories[0],
              env: environment,
              encoding: "utf8",
              timeout: budget()
            })
          ).transport.command === "/bin/cat" &&
          remaining.includes('user_note = "preserved"') &&
          !/^\[mcp_servers\.hapsland\]/m.test(remaining)
    checked(`${host} unrelated server and metadata survive removal`, unrelatedSurvived)
    checked(`${host} owned skill removed`, !existsSync(skillPath))
  }
  checked("zero classifier requests", classifierCalls === 0)
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        archiveSha256: createHash("sha256")
          .update(readFileSync(resolve(archive)))
          .digest("hex"),
        platform: `${process.platform}-${process.arch}`,
        hosts: observedHosts,
        classifierCalls,
        checks,
        limitation:
          "Installed lifecycle and provider-free MCP discovery; canonical skill bytes do not establish native skill invocation or human approval."
      },
      null,
      2
    )}\n`
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
