---
name: hapsland-rule-authoring
description: Capture durable operator corrections as reviewed Hapsland rules, or revise an operator-requested rule. Use during operator review before responding; automatic Hapsland classifier advice uses existing rules and does not trigger capture.
---

# Hapsland rule authoring

**Purpose:** Turn reusable operator feedback into exact, evaluated and explicitly approved Hapsland rules, then check the current task.
**Audience:** Coding agents assisting operators.
**Status:** Active companion workflow.
**Authority:** Maintained agent guidance implementing [accepted Hapsland rule-authoring decisions](https://github.com/dearlordylord/hapsland/issues/297); tool contracts own executable inputs, destinations and effects. This skill grants no independent write or spending authority.
**Expected use:** Apply during operator review when a correction should guide future reviews, or the operator asks to create, revise or remember a rule.
**Lifecycle:** Update alongside the rule-authoring tool contract. Review when supported evidence, configuration ownership or a qualified host's approval path changes.

## Capture the operator's concern

Before finishing a response to a durable correction, reusable preference, approved idiom or explicit remember request, inspect existing rules and prepare a complete proposal. Skip clearly one-off feedback. A rule verified as fully covering the concern can be reused without proposing a duplicate. There is no extra invitation gate before inspection or drafting.

Automatic Hapsland advice consumes enabled existing rules. Repair confirmed task findings within the authorized task; classifier output never initiates rule creation or refinement. Operator review is the source of new requirements.

Use the discovered `derive_rule` and `check_rules` contracts. Every call supplies the explicit absolute repository; verify the physical repository returned, including when working across projects. Tool descriptions supply current executable schemas. Keep source-bearing results private in the conversation; do not create an automatic transcript, example archive or observation database.

Inspect actual complete existing content, origin, activation and effective selection. Explain coverage, overlap and conflicts using those requirements. Preserve meaningful exceptions and unrelated obligations. Clarify only missing information that changes the judgment, evidence, scope or proposed effect.

Hapsland reviews supported declarations and permitted bounded related evidence. Explain an unsupported obligation, such as requiring every API change to update repository documentation, rather than saving it as enforceable or silently weakening its meaning. A missing required input for one supported declaration is instead an explained skip that may be resolved with permitted context.

## Draft and validate the unsaved proposal

Default to Project scope. Personal changes require an explicit operator choice. A Project alternative to an inherited Personal rule uses a distinct identity; show any local disabling in the same proposal.

Draft complete final version-one rule content and exact owned rule/configuration effects. Preview the complete ordered changes through `derive_rule`. Inspect the full content, authorized destinations, scope, existing-rule effects, connections, selection and activation. Preview performs mechanical validation without saving or calling the classifier. Its digest proves freshness, not consent.

Before dispatch, independently inspect the examples and state each expected finding or clear judgment and the reason in the conversation. Expectations are not classifier input. Choose the smallest revealing examples for every materially changed candidate. A new violation detector needs a revealing expected finding; add a clear or boundary case when breadth, exceptions or ambiguity warrant it. Use relevant task declarations where possible. No synthetic pair is required. Do not alter production code solely to manufacture validation fixtures.

For the declared-result concern, `head(xs: number[]): number` throwing on an empty array is an expected finding when empty input is admitted. Returning `number | undefined` is an expected clear example only when the operator intends that remedy; an always-number requirement differs. This does not mean every throw is a violation, and observations cannot prove totality or termination.

Explain the configured backend, selected declaration scope and possible charges before paid checks. Respect existing bounded authorization; obtain authorization when it is missing or the scope/cost would expand. Candidate fields cannot replace credentials/backend or widen source, privacy, supporting-evidence or resource policy.

Call `check_rules` candidate mode with the identical complete previewed changes and digest, using bounded repository-relative positive one-based path/line targets. Current active rules and durable configuration stay unchanged. Check all materially changed candidates under their intended effective settings.

Compare expectations with actual observations: selected declarations, supporting evidence and omissions, effective rules/request settings, probabilities, strict thresholds, finding/clear judgments and request counts. A finding on a known violation is successful example validation. A clear-only observation does not establish violation sensitivity. Mismatch, missing candidate observations, skips, unavailable/stale/failed results and empty selection are incomplete and block activation.

Inspect and repair the candidate or permitted evidence, revise and revalidate, reject, or defer; ask the operator where judgment or authorization is needed. Revised effective inputs require fresh observations. Reuse is optional and requires demonstrably equivalent effective rules, thresholds, model/request settings, source, supporting evidence and accompanying request rules; otherwise run a fresh bounded check. Example observations establish only those cases.

## Obtain exact approval

Present the exact final complete content and all destinations, scope, connections, selection and activation effects together, with **Save**, **Revise** and **Skip** choices. Preserve the exact previewed changes and digest while waiting.

Use native elicitation only if it presents that complete proposal and obtains the operator's own choice. An automatic transport response, tool permission, bare boolean or code-edit permission is not approval to persist a rule. If the native path cannot obtain the choice, use the host agent's question path or an ordinary conversational question and wait for the operator. If no path can obtain actual approval, leave the proposal pending and do not apply.

- **Save:** Apply only the identical final changes and digest. Generate no replacement wording after approval.
- **Revise:** Incorporate actionable feedback, preview again, revalidate changed effective inputs and obtain fresh approval. If no requested change is clear, ask what to revise and leave it pending.
- **Skip:** Stop capture without applying.

Changed content or effects require renewed validation and approval. Cancellation never authorizes application. After restart or a lost proposal, inspect actual state, reconstruct the complete preview, validate where equivalence is unknown and obtain fresh approval; possession of an old digest does not restore consent.

## Apply, inspect and check the task

After Save, call `derive_rule` apply with the exact changes and preview digest. Report saved content, effective activation and check results separately. A successful save alone does not establish evaluated enforcement.

On failure, interruption or partial application, inspect actual inventory and the reported affected files before retrying. Keep known completed effects separate from incomplete or unknown state. Use ordinary repair operations with a renewed preview and approval, reject the candidate, or ask the operator where judgment is needed. Do not claim automatic restoration or a multi-file transaction.

Inspect actual saved and active state after application. Check eligible declarations changed or directly involved in the task using the affected stored rules. Triage findings in context; repair confirmed source violations within existing authorization and recheck changed inputs. Ask when the repair changes intended behavior or needs wider scope. Preserve the rule's meaning rather than weakening it to silence findings. Keep checks bounded to the task; there is no whole-repository audit authority.

Conclude with the saved/active state, scope actually checked, request counts, unresolved findings or incomplete checks, and any decision still needed. Distinguish deterministic mechanics, example classifier observations and recorded host behavior; none establishes universal classifier correctness or untested runtime support.
