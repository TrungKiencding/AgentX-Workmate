export function logError(error: unknown): void {
  if (!process.env.AGENTX_INK_DEBUG_ERRORS) {
    return
  }

  console.error(error)
}
