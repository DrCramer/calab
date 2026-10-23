/** A key by its physical position (`e.code`, so a Russian layout works), falling back to the Latin `e.key` letter. */
export const keyIs = (e: Pick<KeyboardEvent, 'code' | 'key'>, letter: string): boolean =>
  e.code === `Key${letter.toUpperCase()}` || (!/^Key[A-Z]$/.test(e.code) && e.key.toLowerCase() === letter);
