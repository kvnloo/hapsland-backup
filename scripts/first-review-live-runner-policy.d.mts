export function requireCleanInstallationPreview(preview: unknown): string
export function setupAuthorization(preview: unknown): { installProposalDigest: string; rulesProposalDigest: string }
export function requireCreatedSetup(result: unknown): void
export function firstReviewLiveEnvironment(
  inherited: NodeJS.ProcessEnv,
  owned: NodeJS.ProcessEnv,
  sandboxBypass?: boolean
): NodeJS.ProcessEnv
