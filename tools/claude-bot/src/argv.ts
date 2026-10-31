// Command lines of the claude modes. Pure functions, so tests can pin exactly what each mode may do.

/** /check: the lead on Opus with full rights in the lead checkout (the owner's own trust level). */
export function leadArgv(prompt: string): string[] {
  return ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', prompt];
}

/** Read-only paths of the assistant's checkout (relative to its cwd). */
export const ASSIST_READ_PATHS = ['./docs/**', './apps/**'] as const;

/** Built-in tools that exist in the sandboxed runs: file reads only. Everything else goes through MCP. */
export const SANDBOX_BUILTINS = 'Read,Grep,Glob';

/**
 * Settings passed inline (`--settings`): the file tools may not read outside the working directory, and no
 * auto-memory (it would load the owner's project memory). Not `--safe-mode`: it also drops the servers of
 * `--mcp-config` (checked live with Claude Code 2.1.312), and the runs' tools are an MCP server.
 */
export const SANDBOX_SETTINGS = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true }, autoMemoryEnabled: false });

/**
 * Built-in tools denied by name on top of `--tools` (defense in depth). No shell at all: Bash prefix rules
 * are not a boundary, and a deny such as `Bash(node:*)` also matched the absolute node of the old
 * `handoff.mjs` allow rule, so every wake run had all its tools refused (28.10).
 */
export const DENIED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TodoWrite',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
] as const;

/** Paths no sandboxed run may read: secrets, the owner's checkout and session data, the inbox. */
function secretReads(home: string, ownerRepo: string, inboxDir: string): string[] {
  const homeRel = (p: string): string => `~/${p}`;
  const abs = (p: string): string => `/${p.replace(/^\/+/, '/')}`; // permission rules: //abs/path
  // Not ~/.calab-claude-bot as a whole: the runs' checkout lives there (its env files and inbox are below).
  const homeDirs = ['.calab-tools', '.claude', '.ssh', '.aws', '.config', '.kube', '.docker', '.gnupg', '.local', 'Library', 'Documents', 'Desktop', 'Downloads'];
  const homeFiles = ['.netrc', '.npmrc', '.gitconfig', '.zsh_history', '.bash_history', '.claude.json'];
  return [
    './.env*',
    './**/.env*',
    './.git/**',
    './.claude/**',
    ...homeDirs.map((d) => homeRel(`${d}/**`)),
    ...homeFiles.map(homeRel),
    abs(`${ownerRepo}/**`),
    abs(`${home}/.calab-claude-bot/*.env`),
    abs(`${inboxDir}/**`),
  ];
}

export function sandboxDisallowedTools(home: string, ownerRepo: string, inboxDir: string): string[] {
  return [...DENIED_BUILTINS, ...secretReads(home, ownerRepo, inboxDir).flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`])];
}

/**
 * Flags common to the sandboxed runs: no settings, skills or slash commands, no MCP servers but the runs'
 * own (`--strict-mcp-config` + `--mcp-config`), only Read/Grep/Glob of the built-ins; refuse the rest.
 */
function sandboxFlags(maxBudgetUsd: number, mcpConfig: string): string[] {
  return [
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--setting-sources=',
    '--settings',
    SANDBOX_SETTINGS,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--tools',
    SANDBOX_BUILTINS,
  ];
}

export interface SandboxOpts {
  /** JSON for `--mcp-config` (src/mcp.ts `mcpConfig`). */
  mcpConfig: string;
  /** The run's MCP tools, `mcp__calab__…` (src/mcp.ts `mcpToolNames`). */
  mcpTools: readonly string[];
  home: string;
  ownerRepo: string;
  inboxDir: string;
}

export function assistAllowedTools(mcpTools: readonly string[]): string[] {
  return [...ASSIST_READ_PATHS.flatMap((p) => [`Read(${p})`, `Grep(${p})`, `Glob(${p})`]), ...mcpTools];
}

/**
 * The Sonnet assistant: Read/Grep/Glob of docs/ and apps/ of its own checkout and its MCP tools (board
 * reads, comments, new tasks, labels; requests to the lead). The chat goes on stdin.
 */
export function assistArgv(opts: SandboxOpts & { systemPrompt: string; maxBudgetUsd?: number }): string[] {
  return [
    '-p',
    '--model',
    'sonnet',
    '--output-format',
    'json',
    ...sandboxFlags(opts.maxBudgetUsd ?? 0.5, opts.mcpConfig),
    '--system-prompt',
    opts.systemPrompt,
    '--allowedTools',
    ...assistAllowedTools(opts.mcpTools),
    '--disallowedTools',
    ...sandboxDisallowedTools(opts.home, opts.ownerRepo, opts.inboxDir),
  ];
}

// ---- wake runs: the lead woken by the poller, on untrusted input, so never bypassPermissions ----

export function wakeAllowedTools(mcpTools: readonly string[]): string[] {
  return ['Read(./**)', 'Grep(./**)', 'Glob(./**)', ...mcpTools];
}

/**
 * A wake run: the lead on `model` in a clean checkout of main (not the owner's), `dontAsk` with an explicit
 * allowlist (repo reads and the run's MCP tools; no shell). The prompt goes on stdin (the tool lists are
 * variadic).
 */
export function wakeArgv(opts: SandboxOpts & { model: string; maxBudgetUsd: number }): string[] {
  return [
    '-p',
    '--model',
    opts.model,
    '--output-format',
    'stream-json',
    '--verbose',
    ...sandboxFlags(opts.maxBudgetUsd, opts.mcpConfig),
    '--allowedTools',
    ...wakeAllowedTools(opts.mcpTools),
    '--disallowedTools',
    ...sandboxDisallowedTools(opts.home, opts.ownerRepo, opts.inboxDir),
  ];
}
