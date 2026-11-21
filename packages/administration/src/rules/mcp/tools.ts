import { localFailureMessage } from "../../invocation/failure-message.ts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import { CredentialResolver } from "@hapsland/credential-storage/credentials/owner"
import { ReviewSettingsService } from "@hapsland/review-definition/runtime/review-settings"
import * as HttpClient from "effect/http/HttpClient"
import * as Toolkit from "effect/ai/Toolkit"
import {
  InspectRequest,
  MAX_CHECK_TARGETS,
  StoredCheckRequest,
  checkRules,
  inspectRules,
  resolveRepository
} from "./operations.ts"

const DeriveRule = Tool.make("derive_rule", {
  description:
    "Inspect Hapsland rule inventory or a named rule, including complete authored content, origin, enabled state and effective selection. Supply the explicit absolute Git repository on every call. Inspection writes nothing and sends no classifier requests.",
  parameters: InspectRequest,
  success: Schema.JsonObject,
  failure: Schema.Struct({ repository: Schema.String, status: Schema.Literal("unavailable"), reason: Schema.String })
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
const CheckRules = Tool.make("check_rules", {
  description: `Check 1–${MAX_CHECK_TARGETS} repository-relative path/positive one-based line targets against enabled stored Hapsland rules. Supply mode stored, explicit absolute repository and optional enabled rule IDs. Uses independently configured source/privacy/backend/credential/resource policy and can incur configured backend charges. Evaluated finding/clear observations, skips and unavailable/stale failures remain distinct; zero requests or empty selection is never clear. Source-bearing evidence is private to this result; do not automatically archive it.`,
  parameters: StoredCheckRequest,
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
  derive_rule: (request) => inRepository(request, inspectRules).pipe(Effect.map(jsonResult)),
  check_rules: (request) => inRepository(request, checkRules).pipe(Effect.map(jsonResult))
})
