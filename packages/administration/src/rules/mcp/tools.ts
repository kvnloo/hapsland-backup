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
  resolveRepository
} from "./operations.ts"

const DeriveRule = Tool.make("derive_rule", {
  description:
    "Inspect Hapsland rule inventory or a named rule, or preview complete Project rule changes. Supply the explicit absolute Git repository on every call. Inspect includes authored content, origin, activation and selection. Preview requires complete version-one JSONC content, an authorized .hapsland/rules/custom/<encoded-id>.jsonc destination, and exact rule settings. Preview shows complete content, connection, activation and selection plus a freshness digest; it writes nothing and sends no classifier requests. The digest is not human approval.",
  parameters: DeriveRuleRequest,
  success: Schema.JsonObject,
  failure: Schema.Struct({ repository: Schema.String, status: Schema.Literal("unavailable"), reason: Schema.String })
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
const CheckRules = Tool.make("check_rules", {
  description: `Check 1–${MAX_CHECK_TARGETS} repository-relative path/positive one-based line targets. Stored mode selects optional enabled rule IDs. Candidate mode requires the identical complete previewed changes and previewDigest, checks their intended effective configuration without saving or activating them, and rejects stale previews. Each call supplies an explicit absolute repository. Uses independently configured source/privacy/backend/credential/resource policy and can incur configured backend charges; candidate settings cannot widen those policies. State expected judgments before dispatch; mismatch, skips and unavailable/stale results are incomplete and cannot authorize activation. Evaluated finding/clear observations retain actual probabilities, thresholds and request counts. Source-bearing evidence is private to this result; do not automatically archive it.`,
  parameters: CheckRulesRequest,
  success: Schema.JsonObject,
  failure: Schema.Struct({ repository: Schema.String, status: Schema.Literal("unavailable"), reason: Schema.String })
})
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
        : previewRules(resolved).pipe(Effect.map(jsonResult))
    ),
  check_rules: (request) => inRepository(request, checkRules).pipe(Effect.map(jsonResult))
})
