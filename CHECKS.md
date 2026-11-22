# Checks policy

**Purpose:** Select sufficient checks and keep verification cost proportional to product risk.
**Audience:** Contributors, including coding agents; Build and release maintainers.
**Status:** Active repository guidance.
**Authority:** Maintained workflow policy; accepted product contracts own required behavior.
**Expected use:** Read before selecting or changing checks, or running a full gate.
**Lifecycle:** Update with verification workflow changes; review after costly late failures or contract changes.

## Establish required behavior

Find the current user instruction or accepted contract/decision through the
[repository map](docs/agents/navigation.md). Cite its specific requirement.
Code, tests, research and reports alone do not create product requirements.
Missing source: label the assumption; do not promote it to a required guarantee.

Before mandating checks or adding/retaining/optimizing expensive checks: state
accepted goal/source, realistic supported-use failure, goal consequences,
cheapest sufficient evidence. Uniqueness/technical possibility/existing tests
don't justify retention. Remove/simplify checks lacking substantiated goal
relevance. Propose accepted-contract changes/consequences before removing
required behavior.

Prefer short focused checks. Replace integration checks when cheaper checks
establish the same goal-relevant behavior; retain real boundaries when needed.

## Select and run checks

Choose local checks by changed behavior and physical boundaries using the
[testing matrix](docs/testing-matrix.md#which-gate-to-run). For TypeScript changes,
run `npm run check:fast` and focused tests for the changed owners and affected
consumers. Run affected integration checks when transport, process lifetime,
installation, packaging, or cross-component wiring changes.
For delegated tasks and jointly accepted batches, follow
[task and batch acceptance](docs/testing-matrix.md#task-and-batch-acceptance)
for final qualification ownership and timing.

Documentation generation and generated-document drift checks are manual
documentation operations: use `npm run docs:generate` or
`npm run docs:generated:check` explicitly when working on documentation.
Do not invoke them automatically from fast/full gates, Git hooks, product builds,
or CI. Source and product contract checks remain in their existing owners.

- Before checks over one minute: record risk, cheapest adequate existing check,
  additional evidence, expected duration and absolute stop. Relevant cheap
  prerequisites MUST pass first. Reuse runners; tooling changes need measured
  bottleneck or missing task diagnostic.
- Build/test/coverage changes MUST pass a real affected consumer with matching
  environment, instrumentation and product deadlines. Helper tests insufficient.
  Owner/fixture moves MUST pass affected fixtures against current exports/paths.
- Task acceptance uses `check:fast` and goal-selected owner/consumer checks.
  A release also needs one freshly audited archive from `release:prepare`, reused
  for the selected installed conformance checks. Do not rebuild a development
  archive merely to qualify a source-only change. Known relevant failures block
  acceptance; interrupted runs remain interrupted.
- `npm test` is the optional complete uninstrumented deterministic inventory and
  ordinary CI command. Its prechecks validate current candidate boundaries.
  Builder, harness and measurement self-tests are selected with `test:tooling`
  when those tools change; they are not prerequisites for every product test.
- `npm run quality:check -- --ack-checks-policy` is explicit opt-in CRAP/coverage
  analysis. Neither releases nor ordinary CI require it. Select it for an actual
  coverage or complexity question, declare the cost, and keep its evidence strict.
- Failed gate: read `npm run test:status` and logs; classify every independent
  failure (preparation/build/proof/test/analysis). Relevant focused checks MUST
  pass on current inputs before another full run. Failures missed by preflight
  MUST get a focused reproduction; use checks matching the failed stage.
- Two attempts without evidence distinguishing causes or verifying a fix:
  name competing causes; change experiment. Edits/reviewers/broad runs alone
  insufficient. After 30 minutes active fixture repair without such evidence,
  record changed experiment and goal-linked acceptance value before continuing.
  Renaming/delegating work does not reset budget.
- Finite deadlines; at expiry retain evidence and name next diagnostic. Freeze
  verification inputs during full runs. Missing exit/interruption/timeout/changed
  inputs never qualify. Release locks after owner processes and descendants stop.
  Claim executed evidence only; focused passes are not full-project coverage.

When explicitly selected, pinned crap4ts analysis regenerates coverage using the full deterministic
suite. Tests, lint, invalid coverage, missing evidence and analysis errors remain
blocking. CRAP scores above the configured threshold are advisory: retain the
machine report and summarize the affected functions for review. Treat the score
as a navigation aid, not a correctness guarantee or a reason to extract shallow
helpers. Preserve source selection and strict missing-evidence handling.
Generated diagnostics belong in ignored `.test-runs` and short-lived CI artifacts;
they are not repository source or a tracked history archive.
Documentation/tooling changes use affected tool/consumer, type and documentation
checks. Same selection under `src`.

## Explicit analysis and proof selection

Before an explicit quality analysis, confirm this policy was read and applied: required
behavior sourced, checks justified by goals, and relevant cheap prerequisites
passed. Confirmation applies to one run, not a permanent tracked checkbox.
CI checks Bend concrete instances, kernel proofs and semantic mutants once in
its independent proof job. Runtime prechecks do not repeat them. Run the existing
progress and content-isolation proof commands locally when Bend semantics,
proofs, mutants, ABI or compiler change, or when making a new proof claim.
Unrelated TypeScript releases do not require repeating unchanged proof inputs.
Acknowledgment is responsibility, not evidence; passing prerequisites is evidence.

Run `npm run quality:check -- --ack-checks-policy` (or
`npm run verify -- --profile=quality --ack-checks-policy`). The runner rejects
missing acknowledgment before creating run state. Harness prerequisite tests
run once before lint/coverage; ordinary test prechecks do not repeat these self-tests.
These analysis prerequisites validate runner, reporting and verification-plan contracts, not all
product consumers. Run task-specific consumer checks as required above.
