export const requireCleanInstallationPreview = (preview) => {
  if (preview?.status !== "preview" || typeof preview.proposal?.digest !== "string") {
    throw new Error("installed CLI did not produce a complete installation preview")
  }
  if (preview.installed !== false) {
    throw new Error("live milestone requires a clean Codex home without a pre-existing owned installation")
  }
  return preview.proposal.digest
}

export const setupAuthorization = (preview) => {
  const action = (code) => preview?.actions?.find((item) => item.code === code)?.authorization
  const installProposalDigest = action("approve-installation")?.installProposalDigest
  const rulesProposalDigest = action("approve-default-rules")?.rulesProposalDigest
  if (
    ![installProposalDigest, rulesProposalDigest].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    )
  )
    throw new Error("Ordinary setup did not disclose exact installation and default rule approvals")
  return { installProposalDigest, rulesProposalDigest }
}
export const requireCreatedSetup = (result) => {
  for (const stage of ["installation", "rules", "repository", "credential"]) {
    if (result?.stages?.find((item) => item.stage === stage)?.status !== "complete")
      throw new Error(`Ordinary setup did not complete ${stage}`)
  }
}
export const firstReviewLiveEnvironment = (inherited, owned, sandboxBypass = false) => ({
  ...Object.fromEntries(
    [
      "PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SystemRoot",
      "SYSTEMROOT",
      "COMSPEC",
      "PATHEXT",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "TYPESAFE_API_KEY",
      "OPENAI_API_KEY"
    ].flatMap((key) => (typeof inherited[key] === "string" ? [[key, inherited[key]]] : []))
  ),
  ...owned,
  ...(sandboxBypass ? { REVIEW_DEMO_TEST_SANDBOX_BYPASS: "1" } : {})
})
