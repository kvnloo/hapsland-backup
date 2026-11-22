import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, symlink, rm, mkdir, readFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { npmToolingRequire } from "./npm-tooling.mjs"
import { archiveInventory } from "./archive-inventory.mjs"
import { validateReleasePublication } from "./audit-release-tarball.mjs"
import { fileEvidence } from "./compiler-evidence.mjs"

const tar = npmToolingRequire()("tar")
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hapsland-archive-inventory-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "README.md"), "shipped text")
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2, 3]))
  const archive = join(root, "archive.tgz")
  return { root, archive }
}
test("a single scan retains audit text and hashes binary contents without extraction", async (t) => {
  const { root, archive } = await fixture(t)
  await tar.c({ cwd: root, file: archive, prefix: "package", gzip: true }, ["README.md", "binary"])
  const records = await archiveInventory(archive)
  assert.equal(records.size, 2)
  assert.equal(records.get("package/README.md").text.toString(), "shipped text")
  assert.equal(records.get("package/binary").text, undefined)
  assert.equal(
    records.get("package/binary").sha256,
    createHash("sha256")
      .update(Buffer.from([0, 1, 2, 3]))
      .digest("hex")
  )
})
test("symbolic links, duplicate entries and paths outside the package are rejected", async (t) => {
  const { root, archive } = await fixture(t)
  await symlink("README.md", join(root, "link"))
  await tar.c({ cwd: root, file: archive, prefix: "package", gzip: true }, ["link"])
  await assert.rejects(archiveInventory(archive), /non-regular entry/)
  await tar.c({ cwd: root, file: archive, prefix: "package", gzip: true }, ["binary", "binary"])
  await assert.rejects(archiveInventory(archive), /duplicate entries/)
  await tar.c({ cwd: root, file: archive, gzip: true }, ["binary"])
  await assert.rejects(archiveInventory(archive), /unsafe tarball path/)
})
test("text byte bounds and malformed archives are rejected", async (t) => {
  const { root, archive } = await fixture(t)
  await tar.c({ cwd: root, file: archive, prefix: "package", gzip: true }, ["README.md"])
  await assert.rejects(archiveInventory(archive, { textLimit: 1 }), /text exceeds/)
  await writeFile(archive, "not an archive")
  await assert.rejects(archiveInventory(archive))
})

test("canonical authoring skill archives retain inspected text and pinned publication bytes and mode", async (t) => {
  const { root, archive } = await fixture(t)
  const path = "skills/hapsland-rule-authoring/SKILL.md"
  const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8")
  await mkdir(join(root, "skills/hapsland-rule-authoring"), { recursive: true })
  await mkdir(join(root, "skills/unsupported"))
  await writeFile(join(root, path), text, { mode: 0o644 })
  await writeFile(join(root, "skills/unsupported/SKILL.md"), "unreviewed skill")
  const output = { ...fileEvidence(root, join(root, path)), publicPath: path }
  const pack = () =>
    tar.c({ cwd: root, file: archive, prefix: "package", gzip: true }, [path, "skills/unsupported/SKILL.md"])
  await pack()
  const records = await archiveInventory(archive)
  const skill = records.get(`package/${path}`)
  assert.equal(skill.text.toString(), text)
  assert.equal(skill.sha256, createHash("sha256").update(text).digest("hex"))
  assert.equal(skill.mode, 0o644)
  assert.equal(records.get("package/skills/unsupported/SKILL.md").text, undefined)
  validateReleasePublication(root, output, skill)
  await assert.rejects(archiveInventory(archive, { textLimit: 1 }), /text exceeds/)
  await writeFile(join(root, path), "tampered skill")
  await pack()
  await writeFile(join(root, path), text)
  const changed = (await archiveInventory(archive)).get(`package/${path}`)
  assert.throws(() => validateReleasePublication(root, output, changed), /differs/)
  await chmod(join(root, path), 0o755)
  await pack()
  await chmod(join(root, path), 0o644)
  const executable = (await archiveInventory(archive)).get(`package/${path}`)
  assert.throws(() => validateReleasePublication(root, output, executable), /differs/)
})
