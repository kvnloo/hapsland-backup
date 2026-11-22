import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  requireCleanInstallationPreview,
  setupAuthorization,
  requireCreatedSetup,
  firstReviewLiveEnvironment
} from "./first-review-live-runner-policy.mjs"
import { stopScopedResident } from "./first-review-resident-cleanup.mjs"
import { executeNative } from "./native-process.mjs"
import { establishNativeTrust } from "./native-codex-trust.mjs"

const projectRoot = fileURLToPath(new URL("../", import.meta.url))
const explicitLive = process.argv.includes("--live")
const writeEvidence = process.argv.includes("--write-evidence")
const registryArtifact = process.argv.includes("--registry-artifact")
const suppliedArchive = process.argv.find((argument) => argument.startsWith("--archive="))?.slice("--archive=".length)
if (suppliedArchive !== undefined && registryArtifact)
  throw new Error("Select one reviewed local archive or registry artifact")
const releaseManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))
const expectedSha256 = process.argv
  .find((argument) => argument.startsWith("--expected-sha256="))
  ?.slice("--expected-sha256=".length)
if (explicitLive && (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "") || (!registryArtifact && !suppliedArchive))) {
  throw new Error(
    "live milestone requires --archive=PATH or --registry-artifact and --expected-sha256=REVIEWED_ARCHIVE_SHA256"
  )
}
const supervisedTrust = process.argv.includes("--supervised-trust")
const testSandboxBypass = process.argv.includes("--test-sandbox-bypass")
const sourceCodexHome = process.env.REVIEW_LIVE_CODEX_HOME
let interrupted = false
let cleaningUp = false

const run = (command, args, options = {}) => {
  if (interrupted && !cleaningUp) throw new Error("Live fixture interrupted")
  return executeNative(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 10_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: `${JSON.stringify(options.input)}\n` })
  })
}

const requireExit = (result, label, expected = [0]) => {
  if (!expected.includes(result.code)) {
    throw new Error(`${label} exited ${String(result.code)} (${result.signal ?? "no signal"})`)
  }
  return result
}

const parseJson = (result, label) => {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
}

if (!explicitLive) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "not-run",
        reason: "pass --live to explicitly select the bounded synthetic milestone",
        providerCalls: 0
      },
      null,
      2
    )}\n`
  )
  process.exit(0)
}
if (sourceCodexHome === undefined) {
  throw new Error("live milestone requires REVIEW_LIVE_CODEX_HOME")
}

const runnerRoot = await realpath(await mkdtemp(join(tmpdir(), "review-first-live-runner-")))
const onInterrupt = () => {
  interrupted = true
}
process.on("SIGINT", onInterrupt)
process.on("SIGTERM", onInterrupt)
const codexHome = join(runnerRoot, "codex")
const appHome = join(runnerRoot, "home")
const repository = join(runnerRoot, "repository")
const installPrefix = join(runnerRoot, "installed-release")
const stateRoot = join(runnerRoot, "state")
const runnerEnv = firstReviewLiveEnvironment(
  process.env,
  {
    HOME: appHome,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(appHome, ".config"),
    XDG_DATA_HOME: join(appHome, ".local", "share"),
    REVIEW_USER_CONFIG_PATH: join(runnerRoot, "user.jsonc"),
    REVIEW_CREDENTIAL_STATE_PATH: join(stateRoot, "credentials"),
    REVIEW_STATE_PATH: join(stateRoot, "consent"),
    REVIEW_ACTIVITY_PATH: join(stateRoot, "activity"),
    REVIEW_DEMO_STATE_PATH: join(stateRoot, "demo.json"),
    REVIEW_RESIDENT_DIR: join(stateRoot, "resident")
  },
  testSandboxBypass
)

let cli
let preview
let live
let artifactSha256
let codexVersion
let installed = false
let setup

const invoke = async (input, timeoutMs = 10_000, expected = [0]) => {
  const result = requireExit(
    await run(cli, ["--demo"], { env: runnerEnv, input, timeoutMs }),
    `installed CLI ${input.selection}`,
    expected
  )
  return { ...result, output: parseJson(result, `installed CLI ${input.selection}`) }
}

try {
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await mkdir(appHome, { recursive: true, mode: 0o700 })
  await mkdir(repository, { recursive: true, mode: 0o700 })
  requireExit(
    await run("git", ["init", "--quiet", repository], { env: runnerEnv }),
    "fixture repository initialization"
  )
  await mkdir(installPrefix, { recursive: true })
  let tarballPath = suppliedArchive === undefined ? undefined : await realpath(resolve(suppliedArchive))
  if (registryArtifact) {
    const packResult = requireExit(
      await run(
        "npm",
        [
          "pack",
          `${releaseManifest.name}@${releaseManifest.version}`,
          "--json",
          "--ignore-scripts=true",
          "--registry=https://registry.npmjs.org/",
          "--pack-destination",
          runnerRoot
        ],
        { timeoutMs: 120_000 }
      ),
      "npm pack"
    )
    const packEntries = parseJson(packResult, "npm pack")
    const tarballName = packEntries[0]?.filename
    if (typeof tarballName !== "string") throw new Error("npm pack did not identify its tarball")
    tarballPath = join(runnerRoot, tarballName)
  }
  if (tarballPath === undefined) throw new Error("Reviewed archive is unavailable")
  const archiveBytes = await readFile(tarballPath)
  artifactSha256 = createHash("sha256").update(archiveBytes).digest("hex")
  if (artifactSha256 !== expectedSha256) {
    throw new Error("archive SHA-256 differs from reviewed artifact")
  }
  tarballPath = join(runnerRoot, "reviewed.tgz")
  await writeFile(tarballPath, archiveBytes, { mode: 0o600, flag: "wx" })
  // Verify exact private archive bytes before opening the read-only authentication source.
  await writeFile(join(codexHome, "auth.json"), await readFile(join(sourceCodexHome, "auth.json")), { mode: 0o600 })

  requireExit(
    await run(
      "npm",
      [
        "install",
        "--global=false",
        "--legacy-peer-deps",
        "--ignore-scripts=true",
        "--prefer-offline",
        "--omit=dev",
        "--bin-links=true",
        "--prefix",
        installPrefix,
        tarballPath
      ],
      { timeoutMs: 120_000 }
    ),
    "packed release installation"
  )
  const invokedCli = join(installPrefix, "node_modules", ".bin", "hapsland")
  cli = await realpath(invokedCli)
  const installedPackageRoot = await realpath(join(installPrefix, "node_modules", "@hapsland", "hapsland"))
  const resolvedCli = await realpath(cli)
  if (resolvedCli !== installedPackageRoot && !resolvedCli.startsWith(`${installedPackageRoot}${sep}`)) {
    throw new Error("invoked CLI does not resolve inside the installed packed artifact")
  }
  const packageManifest = JSON.parse(await readFile(resolve(dirname(resolvedCli), "../package.json"), "utf8"))
  if (packageManifest.name !== "@hapsland/hapsland") {
    throw new Error("installed CLI package identity did not match the packed release")
  }

  const versionResult = requireExit(
    await run("codex", ["--version"], { env: runnerEnv, timeoutMs: 10_000 }),
    "codex --version"
  )
  codexVersion = versionResult.stdout.trim()
  if (codexVersion.length === 0) throw new Error("codex --version returned an empty version")

  const installPreviewRun = requireExit(
    await run(cli, ["--install-preview"], {
      env: runnerEnv,
      input: { version: 1, operation: "install-preview", codexHome, codexExecutable: "codex" }
    }),
    "installed CLI install preview"
  )
  const installPreview = parseJson(installPreviewRun, "installed CLI install preview")
  requireCleanInstallationPreview(installPreview)
  const setupRequest = {
    version: 1,
    operation: "setup",
    host: "codex",
    codexHome,
    codexExecutable: "codex",
    credential: "environment",
    scope: { cwd: repository, review: "enabled" }
  }
  const setupPreviewRun = requireExit(
    await run(cli, ["--setup"], { env: runnerEnv, input: setupRequest }),
    "ordinary setup preview",
    [0, 6]
  )
  const approvals = setupAuthorization(parseJson(setupPreviewRun, "ordinary setup preview"))
  const installRun = requireExit(
    await run(cli, ["--setup"], { env: runnerEnv, input: { ...setupRequest, ...approvals } }),
    "installed CLI install",
    [0, 6]
  )
  setup = parseJson(installRun, "ordinary setup apply")
  requireCreatedSetup(setup)
  installed = true

  preview = await invoke({ version: 1, operation: "demo", selection: "preview", codexHome, codexExecutable: "codex" })
  if (preview.output?.status !== "preview") throw new Error("installed release did not produce an offline demo preview")
  if (
    preview.output.paidVerificationPerformed !== false ||
    preview.output.budget?.sourceBytes !== 4_096 ||
    preview.output.budget?.providerCalls !== 2 ||
    preview.output.budget?.timeMs !== 180_000
  ) {
    throw new Error("demo preview did not preserve the declared offline budget contract")
  }

  if (supervisedTrust) {
    const disposableRoot = preview.output.demo?.disposableRoot
    if (typeof disposableRoot !== "string") throw new Error("demo preview omitted its disposable root")
    await establishNativeTrust(codexHome, disposableRoot, runnerEnv)
  }

  live = await invoke(
    {
      version: 1,
      operation: "demo",
      selection: "live",
      demoId: preview.output.demo.id,
      selectionDigest: preview.output.authorization.selectionDigest,
      codexHome,
      codexExecutable: "codex"
    },
    195_000,
    [0, 6]
  )
} finally {
  cleaningUp = true
  let cleanupFailure
  const retainCleanupFailure = (cause) => {
    cleanupFailure ??= cause
  }
  if (
    preview?.output?.demo?.id !== undefined &&
    live?.output?.cleanup?.disposableRootRemoved !== true &&
    cli !== undefined
  ) {
    await invoke({ version: 1, operation: "demo", selection: "cancel", demoId: preview.output.demo.id }).catch(
      retainCleanupFailure
    )
  }
  if (installed && cli !== undefined) {
    await (async () => {
      const uninstallPreviewRun = requireExit(
        await run(cli, ["--uninstall"], { env: runnerEnv, input: { version: 1, operation: "uninstall", codexHome } }),
        "installed CLI uninstall preview"
      )
      const uninstallPreview = parseJson(uninstallPreviewRun, "installed CLI uninstall preview")
      if (uninstallPreview.status !== "preview" || typeof uninstallPreview.proposal?.digest !== "string") {
        throw new Error("installed CLI did not produce a scoped uninstall preview")
      }
      const uninstallRun = requireExit(
        await run(cli, ["--uninstall"], {
          env: runnerEnv,
          input: { version: 1, operation: "uninstall", codexHome, proposalDigest: uninstallPreview.proposal.digest }
        }),
        "installed CLI uninstall"
      )
      const uninstallResult = parseJson(uninstallRun, "installed CLI uninstall")
      if (uninstallResult.status !== "uninstalled") {
        throw new Error("installed CLI did not complete scoped uninstall")
      }
    })().catch(retainCleanupFailure)
  }
  await stopScopedResident(stateRoot).catch(retainCleanupFailure)
  for (const directory of [codexHome, appHome, installPrefix, repository])
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(retainCleanupFailure)
  for (const name of await readdir(stateRoot).catch(() => []))
    if (name !== "resident")
      await rm(join(stateRoot, name), { recursive: true, force: true }).catch(retainCleanupFailure)
  for (const name of await readdir(runnerRoot).catch(() => []))
    if (name !== "state") await rm(join(runnerRoot, name), { recursive: true, force: true }).catch(retainCleanupFailure)
  if (cleanupFailure === undefined)
    await rm(runnerRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(retainCleanupFailure)
  process.removeListener("SIGINT", onInterrupt)
  process.removeListener("SIGTERM", onInterrupt)
  // oxlint-disable-next-line no-unsafe-finally -- Uncertain cleanup must fail the witness and retain its fixture evidence.
  if (cleanupFailure !== undefined) throw cleanupFailure
}

const result = live?.output
const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  milestone: "installed-product-first-review",
  environment: {
    codex: codexVersion,
    node: process.version,
    operatingSystem: process.platform,
    architecture: process.arch
  },
  package: {
    source: registryArtifact ? "npm-registry-installation" : "reviewed-local-archive-installation",
    artifactSha256,
    cliResolvedInsideInstalledArtifact: true
  },
  selection: {
    explicitLive: true,
    syntheticOnly: preview.output.demo.syntheticOnly === true,
    deliberatelyFlawed: preview.output.demo.disclosure.deliberatelyFlawed === true,
    repairPrescribed: preview.output.demo.disclosure.repairPrescribed === true,
    exactDisposableSelection: typeof preview.output.authorization.selectionDigest === "string",
    supervisedNativeTrust: supervisedTrust,
    hostSandboxMode: runnerEnv.REVIEW_DEMO_TEST_SANDBOX_BYPASS === "1" ? "test-bypass" : "workspace-write",
    hostModel: "Codex default",
    budgets: preview.output.budget
  },
  setup: {
    ordinaryDefaults: true,
    status: setup?.status,
    installation: setup?.stages?.find((stage) => stage.stage === "installation")?.status,
    rules: setup?.stages?.find((stage) => stage.stage === "rules")?.status
  },
  reviewLatencyMs: result?.reviewLatencyMs ?? null,
  status: result?.status ?? "incomplete",
  stages: result?.evidence ?? {
    completion: "incomplete",
    submission: "unavailable",
    modelReaction: "unavailable",
    modelReactionSource: "unavailable",
    deliveredFindingCorrelation: false,
    repair: "not-validated",
    followUpReview: "unavailable"
  },
  cleanup: result?.cleanup ?? { disposableRootRemoved: false },
  retained: { source: false, providerResponse: false, credential: false, paths: false, digests: false }
}

if (writeEvidence) {
  const directory = resolve(projectRoot, ".test-runs/first-review")
  await mkdir(directory, { recursive: true })
  const version = /^codex-cli (\d+\.\d+\.\d+)$/.exec(codexVersion ?? "")?.[1]
  if (version === undefined) throw new Error("installed first-review Codex version is unavailable")
  await writeFile(
    resolve(directory, `live-installed-codex-${version}-supervised.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 }
  )
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (evidence.status !== "passed") process.exitCode = 1
