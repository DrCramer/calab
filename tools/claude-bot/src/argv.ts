// Command lines of the two claude modes. Pure functions, so tests can pin exactly what each mode may do.

/** /check: the lead on Opus with full rights in the lead checkout (the owner's own trust level). */
export function leadArgv(prompt: string): string[] {
  return ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', prompt];
}

/** Read-only paths of the assistant's checkout (relative to its cwd). */
export const ASSIST_READ_PATHS = ['./docs/**', './apps/**'] as const;

/** Board commands the assistant may run (create and label a bug, comment, read); never `status`. */
export const BUGBOARD_VERBS = ['list', 'show', 'comment', 'create', 'label'] as const;

export function assistAllowedTools(bugboard: string): string[] {
  return [
    ...ASSIST_READ_PATHS.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]),
    ...BUGBOARD_VERBS.map((v) => `Bash(python3 ${bugboard} ${v}:*)`),
  ];
}

export function assistDisallowedTools(home: string, ownerRepo: string): string[] {
  const homeRel = (p: string): string => `~/${p}`;
  const abs = (p: string): string => `/${p.replace(/^\/+/, '/')}`; // permission rules: //abs/path
  const secretReads = [
    './.env*',
    './**/.env*',
    homeRel('.calab-tools/**'),
    homeRel('.claude/**'),
    homeRel('.ssh/**'),
    homeRel('.aws/**'),
    homeRel('.config/**'),
    homeRel('Library/**'),
    abs(`${ownerRepo}/**`),
    abs(`${home}/.calab-claude-bot/*.env`),
  ];
  return [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'Agent',
    'Task',
    'Bash(python3 * status:*)',
    ...secretReads.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]),
  ];
}

/**
 * The Sonnet assistant: only Read/Grep/Glob/Bash exist (`--tools`), Bash only for the board helper,
 * reads only in docs/ and apps/ of its own checkout; user/project settings, MCP servers, skills and
 * CLAUDE.md are not loaded (`--safe-mode`, `--strict-mcp-config`, `--setting-sources ''`); whatever is not
 * allowed is refused without a prompt (`dontAsk`). The chat goes on stdin.
 */
export function assistArgv(opts: { systemPrompt: string; bugboard: string; home: string; ownerRepo: string; maxBudgetUsd?: number }): string[] {
  return [
    '-p',
    '--model',
    'sonnet',
    '--output-format',
    'json',
    '--safe-mode',
    '--strict-mcp-config',
    '--setting-sources=',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--max-budget-usd',
    String(opts.maxBudgetUsd ?? 0.5),
    '--system-prompt',
    opts.systemPrompt,
    '--tools',
    'Read,Grep,Glob,Bash',
    '--allowedTools',
    ...assistAllowedTools(opts.bugboard),
    '--disallowedTools',
    ...assistDisallowedTools(opts.home, opts.ownerRepo),
  ];
}
