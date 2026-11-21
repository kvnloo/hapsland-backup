import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readCodexInstallationSource } from "./administration-workflow-source.mjs"
import { assertInstallationConfigurationBoundary } from "./check-configuration-boundary.mjs"
const root = fileURLToPath(new URL("..", import.meta.url))
for (const [runtime, variable, source] of [
  [
    "claude",
    "CLAUDE_CONFIG_DIR",
    readFileSync(new URL("../packages/administration/src/onboarding/claude-installation.ts", import.meta.url), "utf8")
  ],
  ["codex", "CODEX_HOME", readCodexInstallationSource(root)]
]) {
  test(`${runtime} permits only its reviewed read-only registration selector and keeps mutation configuration caller-owned`, () => {
    assert.doesNotThrow(() => assertInstallationConfigurationBoundary(runtime, source))
    assert.throws(
      () =>
        assertInstallationConfigurationBoundary(runtime, source + `\nconst mutationInput = process.env.${variable}`),
      /caller Config/
    )
    assert.throws(
      () =>
        assertInstallationConfigurationBoundary(
          runtime,
          source.replace(`process.env.${variable}`, `process.env.UNRELATED_PROFILE`)
        ),
      /caller Config/
    )
    assert.throws(
      () =>
        assertInstallationConfigurationBoundary(
          runtime,
          source
            .replace("return settings.includes(MARKER)", "writeProfile(); return settings.includes(MARKER)")
            .replace("return hooks.includes(OWNED_MARKER)", "writeProfile(); return hooks.includes(OWNED_MARKER)")
        ),
      /caller Config/
    )
  })
}
