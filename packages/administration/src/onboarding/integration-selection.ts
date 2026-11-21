import * as Schema from "effect/Schema"

/** MCP and its companion skill are one optional integration, independent of hooks. */
export const IntegrationSelection = Schema.Struct({ hooks: Schema.Boolean, mcp: Schema.Boolean }).check(
  Schema.makeFilter((selection) => selection.hooks || selection.mcp || "select hooks, MCP plus skill, or both")
)
export type IntegrationSelection = typeof IntegrationSelection.Type

export const resolveIntegrationSelection = (
  requested: IntegrationSelection | undefined,
  recorded: IntegrationSelection | undefined
): IntegrationSelection => requested ?? recorded ?? { hooks: true, mcp: false }
