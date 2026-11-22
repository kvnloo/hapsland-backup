import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import assert from "node:assert/strict"
import { establishNativeTrust } from "./native-codex-trust.mjs"

const fixture = () => {
  const child = new EventEmitter()
  child.pid = 123456
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const terminal = Object.assign(new PassThrough(), { isTTY: true })
  const output = new PassThrough()
  const signals = []
  let selected
  return {
    child,
    signals,
    terminal,
    output,
    ports: {
      terminal,
      output,
      timeoutMs: 300,
      killGraceMs: 20,
      spawnProcess: (command, args, options) => {
        selected = { command, args, options }
        return child
      },
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal })
        if (signal === "SIGTERM") setImmediate(() => child.emit("close", null, "SIGTERM"))
      }
    },
    selected: () => selected
  }
}
test("owns the selected private-profile trust process until it closes", async () => {
  const f = fixture()
  await establishNativeTrust(
    "/private/profile",
    "/private/repository",
    {},
    {
      ...f.ports,
      readConfiguration: async () =>
        `[projects."/private/repository"]\ntrust_level = "trusted"\n[hooks.state."/private/profile/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n`
    }
  )
  assert.equal(f.selected().options.env.CODEX_HOME, "/private/profile")
  assert.equal(f.selected().options.stdio[0], f.terminal)
  assert.equal(f.selected().options.detached, process.platform !== "win32")
  assert.deepEqual(
    f.signals.map(({ signal }) => signal),
    ["SIGTERM", "SIGKILL"]
  )
})
test("a timeout waits for owned process closure before rejecting", async () => {
  const f = fixture()
  let settled = false
  const running = establishNativeTrust(
    "/private/profile",
    "/private/repository",
    {},
    {
      ...f.ports,
      timeoutMs: 10,
      killGraceMs: 100,
      readConfiguration: async () => "",
      signalProcess: (pid, signal) => f.signals.push({ pid, signal })
    }
  ).finally(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(settled, false)
  assert.equal(f.signals[0].signal, "SIGTERM")
  f.child.emit("close", null, "SIGTERM")
  await assert.rejects(running, /timed out/)
})
test("another repository's persisted trust cannot approve the selected private fixture", async () => {
  const f = fixture()
  await assert.rejects(
    establishNativeTrust(
      "/private/profile",
      "/private/repository",
      {},
      {
        ...f.ports,
        timeoutMs: 130,
        readConfiguration: async () =>
          `[projects."/private/repository"]\ntrust_level = "untrusted"\n[projects."/other"]\ntrust_level = "trusted"\n[hooks.state."/private/profile/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"`
      }
    ),
    /timed out/
  )
})
test("noninteractive trust is refused before any child process starts", async () => {
  const f = fixture()
  await assert.rejects(
    establishNativeTrust("/private/profile", "/private/repository", {}, { ...f.ports, terminal: { isTTY: false } }),
    /requires a terminal/
  )
  assert.equal(f.selected(), undefined)
})
test("a configuration read completing after child closure cannot signal its retired process group", async () => {
  const f = fixture()
  let resolveRead
  const configuration = new Promise((resolve) => {
    resolveRead = resolve
  })
  const running = establishNativeTrust(
    "/private/profile",
    "/private/repository",
    {},
    { ...f.ports, readConfiguration: () => configuration }
  )
  await new Promise((resolve) => setTimeout(resolve, 110))
  const rejected = assert.rejects(running, /did not persist trust/)
  f.child.emit("close", 1, null)
  await rejected
  resolveRead(
    `[projects."/private/repository"]\ntrust_level = "trusted"\n[hooks.state."/private/profile/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"`
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(f.signals, [])
})
