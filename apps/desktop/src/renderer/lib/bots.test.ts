import { describe, expect, it } from 'vitest';
import { viaBotSuffix, viaBotText } from './bots';

describe('the «via bot» mark (ADR-0106)', () => {
  it('names the bot after the author', () => {
    expect(viaBotText('Ассистент')).toBe('через бота Ассистент');
    expect(viaBotSuffix('Ассистент')).toBe('(через бота Ассистент)');
  });

  it('still marks the action while the bot’s name is unknown', () => {
    expect(viaBotText('')).toBe('через бота');
    expect(viaBotSuffix('  ')).toBe('(через бота)');
  });
});
