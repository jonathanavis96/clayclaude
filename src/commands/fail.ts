/** A mistake the user can fix (a typo in an option, a port in use): one plain line on stderr and exit status 1, never a stack trace. */
export function userError(msg: string, usage?: string): void {
  console.error(`clayclaude: ${msg}${usage ? `\n${usage}` : ''}`);
  process.exitCode = 1;
}

/** Why the server could not listen, in words. */
export const listenError = (e: unknown, port: number, hint = 'is clayclaude already running?') => {
  const code = (e as { code?: string } | undefined)?.code;
  return code === 'EADDRINUSE' ? `port ${port} is already in use (${hint})`
    : code === 'EACCES' ? `no permission to listen on port ${port}`
    : `cannot start the server on port ${port}: ${e instanceof Error ? e.message : String(e)}`;
};
