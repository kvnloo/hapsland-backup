import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  ResidentCleanupLimitation,
  probeScopedResident,
  stopScopedResident
} from "../../scripts/first-review-resident-cleanup.mjs"
import {
  decodeCurrentResidentRequest,
  encodeCurrentResidentResponse
} from "@hapsland/resident-transport/resident/protocol"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ownerFixture = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "first-review-resident-cleanup-"))
  roots.push(stateRoot)
  mkdirSync(join(stateRoot, "resident"), { mode: 0o700 })
  writeFileSync(
    join(stateRoot, "resident", "owner.json"),
    JSON.stringify({ pid: 41_000, lifetime: "original-resident-lifetime" }),
    { mode: 0o600 }
  )
  return stateRoot
}

describe("first-review scoped resident cleanup", () => {
  it("probes the current resident wire version", async () => {
    const stateRoot = ownerFixture()
    const socketPath = join(stateRoot, "resident", "resident.sock")
    let observed: unknown
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        observed = decodeCurrentResidentRequest(chunk.toString("utf8").trim())
        socket.end(
          `${encodeCurrentResidentResponse({
            status: "ready",
            pid: 41_000,
            lifetime: "original-resident-lifetime",
            build: "fixture"
          })}\n`
        )
      })
    })
    await new Promise<void>((resolve, reject) => server.listen(socketPath, () => resolve()).once("error", reject))
    try {
      await expect(probeScopedResident(join(stateRoot, "resident"))).resolves.toEqual({
        pid: 41_000,
        lifetime: "original-resident-lifetime"
      })
      expect(observed).toEqual({ requestRoute: "shared", operation: "hello" })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("does not signal a recycled pid whose endpoint lifetime differs from the stale owner", async () => {
    const stateRoot = ownerFixture()
    const signals: Array<readonly [number, NodeJS.Signals | 0]> = []
    await expect(
      stopScopedResident(stateRoot, {
        probe: async () => ({ pid: 41_000, lifetime: "replacement-process-lifetime" }),
        signal: (pid, signal) => {
          signals.push([pid, signal])
        }
      })
    ).rejects.toBeInstanceOf(ResidentCleanupLimitation)
    expect(signals).toEqual([])
  })

  it("does not signal when the scoped endpoint cannot verify the owner identity", async () => {
    const stateRoot = ownerFixture()
    const signals: Array<NodeJS.Signals | 0> = []
    await expect(
      stopScopedResident(stateRoot, {
        probe: async () => {
          throw new Error("endpoint unavailable")
        },
        signal: (_pid, signal) => {
          signals.push(signal)
        }
      })
    ).rejects.toThrow("no process was signaled")
    expect(signals.filter((signal) => signal !== 0)).toEqual([])
  })
  it("recognizes a stale owner whose unavailable endpoint belongs to an absent PID without terminating anything", async () => {
    const stateRoot = ownerFixture()
    const signals: Array<NodeJS.Signals | 0> = []
    await expect(
      stopScopedResident(stateRoot, {
        probe: async () => {
          throw new Error("endpoint closed")
        },
        signal: (_pid, signal) => {
          signals.push(signal)
          throw Object.assign(new Error("absent"), { code: "ESRCH" })
        }
      })
    ).resolves.toEqual({ status: "already-stopped" })
    expect(signals).toEqual([0])
  })
  it.each(["probe", "terminate", "wait"])("keeps permission ambiguity during %s as failed cleanup", async (phase) => {
    const stateRoot = ownerFixture()
    const signals: Array<NodeJS.Signals | 0> = []
    await expect(
      stopScopedResident(stateRoot, {
        probe: async () => {
          if (phase === "probe") throw new Error("endpoint unavailable")
          return { pid: 41_000, lifetime: "original-resident-lifetime" }
        },
        signal: (_pid, signal) => {
          signals.push(signal)
          if (phase !== "wait" || signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" })
        }
      })
    ).rejects.toBeInstanceOf(ResidentCleanupLimitation)
    if (phase === "probe") expect(signals.filter((signal) => signal !== 0)).toEqual([])
  })
})
