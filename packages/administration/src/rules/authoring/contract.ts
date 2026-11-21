import * as Schema from "effect/Schema"
import { RuleSettings } from "@hapsland/runtime-inputs/configuration/types"
import { RuleDefinition } from "@hapsland/review-definition/rules/schema"
import { TYPE_CAPABILITIES, FUNCTION_CAPABILITIES } from "@hapsland/review-definition/rules/targets"
import { RuleIdentitySchema } from "@hapsland/runtime-inputs/domain/rule-identity"

export const RuleScope = Schema.Literals(["project", "personal"])
export type RuleScope = typeof RuleScope.Type
const contentFields = {
  scope: RuleScope,
  path: Schema.NonEmptyString,
  content: Schema.NonEmptyString.annotate({
    description: `Complete version-one JSONC bytes, validated against the current rule owner: ${JSON.stringify(Schema.toJsonSchemaDocument(RuleDefinition))}. Supported type capabilities: ${TYPE_CAPABILITIES.join(", ")}. TypeScript function capabilities: ${FUNCTION_CAPABILITIES.join(", ")}. Unsupported evidence obligations cannot be evaluated.`
  }),
  settings: RuleSettings
}
/** Complete authored bytes and only the existing rule owner's configuration fields. */
export const RuleContentChange = Schema.Union([
  Schema.Struct({ action: Schema.Literal("create"), ...contentFields }),
  Schema.Struct({ action: Schema.Literal("replace"), id: RuleIdentitySchema, ...contentFields })
])
export type RuleContentChange = typeof RuleContentChange.Type
export const RuleConfigurationChange = Schema.Struct({
  action: Schema.Literal("configure"),
  scope: RuleScope,
  id: RuleIdentitySchema,
  settings: RuleSettings
})
export const RuleChanges = Schema.Array(Schema.Union([RuleContentChange, RuleConfigurationChange])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10)
)
export type RuleChanges = typeof RuleChanges.Type

export const PreviewDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
