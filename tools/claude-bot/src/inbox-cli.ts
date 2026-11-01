// The lead's reader of the handoff inbox (README «Handoff inbox»):
//   inbox.mjs list [--all] | show ID | done ID "note"
// Directory: CLAUDE_BOT_INBOX_DIR, default ~/.calab-claude-bot/inbox.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatList, formatShow, getRequest, HandoffError, listRequests, markDone } from './inbox.js';

const dir = process.env.CLAUDE_BOT_INBOX_DIR ?? join(homedir(), '.calab-claude-bot', 'inbox');

function main(argv: string[]): string {
  const [cmd, a, b] = argv;
  if (!cmd || cmd === 'list') return formatList(listRequests(dir), a === '--all');
  if (cmd === 'show' && a) return formatShow(getRequest(dir, a));
  if (cmd === 'done' && a && b) {
    const r = markDone(dir, a, b, new Date());
    return `${r.id} done`;
  }
  throw new HandoffError('usage: inbox.mjs list [--all] | show ID | done ID "note"');
}

try {
  process.stdout.write(`${main(process.argv.slice(2))}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
