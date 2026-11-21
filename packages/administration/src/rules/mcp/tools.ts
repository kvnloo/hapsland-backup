import { localFailureMessage } from "../../invocation/failure-message.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import { CredentialResolver } from "@hapsland/credential-storage/credentials/owner"
import { ReviewSettingsService } from "@hapsland/review-definition/runtime/review-settings"
import * as HttpClient from "effect/http/HttpClient"
import * as Toolkit from "effect/ai/Toolkit"
import {
  DeriveRuleRequest,
  MAX_CHECK_TARGETS,
  CheckRulesRequest,
  checkRules,
  inspectRules,
  previewRules,
  applyRules,
  resolveRepository
} from "./operations.ts"

const DeriveRule = Tool.make("derive_rule", {
  description:
    "Inspect Hapsland rule inventory or a named rule, preview an ordered proposal, or apply the identical proposal after conversational operator approval. Every call supplies an explicit absolute Git repository. Inspect includes complete authored content, origin, activation and selection. Preview accepts complete version-one JSONC creations or replacements and scoped configure actions using only existing per-rule settings. Project is the conversational default; Personal changes require explicit operator choice and can affect other projects. Creation uses .hapsland/rules/custom/<encoded-id>.jsonc for Project or <user-config-directory>/rules/custom/<encoded-id>.jsonc for Personal. Replacement names an existing ID and its actual authored destination/scope; a Project settings override does not grant authority to replace Personal content. A distinct-ID Project alternative can configure the inherited ID disabled locally in the same preview. Preview shows complete content, destinations, scopes, before/after affected rules, connection, activation and selection plus a freshness digest, with no writes or classifier calls. Apply takes identical complete changes and previewDigest, recomputes under existing mutation locks, and rejects stale/unauthorized plans before writes. Results separate saved bytes, effective activation and incomplete/unknown effects. Inspect actual state before repair; no rollback or classifier validation is implied. Digest, tool permission and a boolean are not human approval; use the companion skill to obtain the exact operator choice.",
  parameters: DeriveRuleRequest,
  success: Schema.JsonObject,
  failure: Schema.Struct({ repository: Schema.String, status: Schema.Literal("unavailable"), reason: Schema.String })
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
const CheckRules = Tool.make("check_rules", {
  description: `Check 1–${MAX_CHECK_TARGETS} repository-relative path/positive one-based line targets. Stored mode selects optional enabled rule IDs. Candidate mode requires the identical complete previewed changes and previewDigest, checks their intended effective configuration without saving or activating them, and rejects stale previews. Each call supplies an explicit absolute repository. Uses independently configured source/privacy/backend/credential/resource policy and can incur configured backend charges; candidate settings cannot widen those policies. State expected judgments before dispatch; mismatch, skips and unavailable/stale results are incomplete and cannot authorize activation. Evaluated finding/clear observations retain actual probabilities, thresholds and request counts. Source-bearing evidence is private to this result; do not automatically archive it.`,
  parameters: CheckRulesRequest,
  success: Schema.JsonObject,
  failure: Schema.Struct({ repository: Schema.String, status: Schema.Literal("unavailable"), reason: Schema.String })
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const RuleAuthoringTools = Toolkit.make(
  DeriveRule,
  CheckRules.addDependency(CredentialResolver).addDependency(ReviewSettingsService).addDependency(HttpClient.HttpClient)
)
const jsonResult = (result: unknown) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(JSON.stringify(result)))
const failureMessage = localFailureMessage
const inRepository = <A extends { readonly repository: string }, B, E, R>(
  request: A,
  run: (request: A) => Effect.Effect<B, E, R>
) =>
  resolveRepository(request.repository).pipe(
    Effect.mapError((error) => ({
      repository: request.repository,
      status: "unavailable" as const,
      reason: `repository-resolution: ${failureMessage(error)}`
    })),
    Effect.flatMap((resolved) =>
      run({ ...request, repository: resolved.root }).pipe(
        Effect.mapError((error) => ({
          repository: resolved.root,
          status: "unavailable" as const,
          reason: failureMessage(error)
        }))
      )
    )
  )
export const ruleAuthoringHandlers = RuleAuthoringTools.toLayer({
  derive_rule: (request) =>
    inRepository(request, (resolved) =>
      resolved.operation === "inspect"
        ? inspectRules(resolved).pipe(Effect.map(jsonResult))
        : resolved.operation === "preview"
          ? previewRules(resolved).pipe(Effect.map(jsonResult))
          : applyRules(resolved).pipe(Effect.map(jsonResult))
    ),
  check_rules: (request) => inRepository(request, checkRules).pipe(Effect.map(jsonResult))
})
