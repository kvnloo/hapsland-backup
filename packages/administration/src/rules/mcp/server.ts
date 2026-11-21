import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Layer from "effect/Layer"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import { PACKAGE_VERSION } from "@hapsland/runtime-environment/runtime/cli-information"
import { rulesCommandLiveLayer } from "../command.ts"
import { RuleAuthoringTools, ruleAuthoringHandlers } from "./tools.ts"

/** The selected host owns this foreground stdio process. No project is inferred from its cwd. */
export const runRuleAuthoringServer = Layer.launch(
  McpServer.toolkit(RuleAuthoringTools).pipe(
    Layer.provide(ruleAuthoringHandlers),
    Layer.provide(rulesCommandLiveLayer),
    Layer.provide(
      McpServer.layerStdio({
        name: "hapsland",
        version: PACKAGE_VERSION,
        instructions:
          "Every tool call requires an explicit absolute repository. Use the Hapsland companion skill for conversational rule authoring; transport permission is not approval to save a rule.",
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05]
      })
    ),
    Layer.provide(NodeStdio.layer)
  )
).pipe(
  Effect.provide(
    Logger.layer([
      Logger.make(() => {
        process.stderr.write("Hapsland MCP internal operation unavailable.\n")
      })
    ])
  )
)
