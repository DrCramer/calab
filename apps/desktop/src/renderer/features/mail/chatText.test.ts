// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { MailAttachment, MailMessage } from '../../../shared/mail';
import { setLocale } from '../../i18n';
import { CHAT_LIMIT, chatAttachments, chatText, htmlToText, planAttachments, stripSignature } from './chatText';

type Src = Pick<MailMessage, 'subject' | 'from' | 'date' | 'text' | 'html' | 'snippet'>;
const src = (over: Partial<Src> = {}): Src => ({
  subject: 'Бюджет',
  from: { name: 'Анна Петрова', address: 'anna@x.io' },
  date: new Date(2026, 9, 12, 13, 28).getTime(),
  text: 'Привет\nКак дела?',
  html: null,
  snippet: 'Привет',
  ...over,
});
const att = (over: Partial<MailAttachment>): MailAttachment => ({ id: '1', name: 'a.pdf', mime: 'application/pdf', size: 10, inline: false, ...over });

beforeAll(async () => {
  await setLocale('ru');
});

describe('«Отправить в чат…» text', () => {
  it('plain: bold subject, sender · date, a blank line, the body', () => {
    const lines = chatText(src()).split('\n');
    expect(lines[0]).toBe('✉️ **Бюджет**');
    expect(lines[1]).toMatch(/^От: Анна Петрова <anna@x\.io> · .+/);
    expect(lines.slice(2)).toEqual(['', 'Привет', 'Как дела?']);
  });

  it('html only: the text comes from the HTML with paragraph breaks, scripts and styles dropped', () => {
    const html = '<style>p{color:red}</style><div>Привет,<br>коллеги</div><p>Второй <b>абзац</b></p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('Привет,\nколлеги\n\nВторой абзац');
    const out = chatText(src({ text: null, html }));
    expect(out).toContain('Привет,\nколлеги');
    expect(out).toContain('Второй абзац');
    expect(out).not.toMatch(/alert|color:red|<p>/);
  });

  it('no subject and no body: just the header', () => {
    expect(chatText(src({ subject: '', text: '', snippet: '' })).split('\n')[0]).toBe('✉️ **(без темы)**');
    expect(chatText(src({ text: '', snippet: '' })).split('\n')).toHaveLength(2);
  });

  it('a trailing «-- » signature block is trimmed', () => {
    expect(stripSignature('Текст\n\n-- \nАнна\nОтдел')).toBe('Текст');
    expect(stripSignature('a -- b\nc')).toBe('a -- b\nc');
    expect(chatText(src({ text: 'Ок\r\n-- \r\nАнна' }))).not.toContain('Анна\n');
  });

  it('a long body is cut to the chat limit with «…» and the note', () => {
    const out = chatText(src({ text: 'а'.repeat(10_000) }));
    expect(out.length).toBeLessThanOrEqual(CHAT_LIMIT);
    expect(out.endsWith('…\n\n(письмо сокращено)')).toBe(true);
    expect(chatText(src({ text: 'а'.repeat(100) })).length).toBeLessThan(400);
  });
});

describe('«Отправить в чат…» attachments', () => {
  it('regular files go, cid images used in the HTML do not', () => {
    const list = [
      att({ id: '1', name: 'report.pdf' }),
      att({ id: '2', name: 'logo.png', mime: 'image/png', inline: true, cid: 'logo@x' }),
      att({ id: '3', name: 'pic.png', mime: 'image/png', cid: 'pic@x' }),
      att({ id: '4', name: 'unused.png', mime: 'image/png', cid: 'unused@x' }),
    ];
    const html = '<p>hi</p><img src="cid:logo@x"><img src="CID:pic@x">';
    expect(chatAttachments({ attachments: list, html }).map((a) => a.name)).toEqual(['report.pdf', 'unused.png']);
    expect(chatAttachments({ attachments: list, html: null }).map((a) => a.name)).toEqual(['report.pdf', 'pic.png', 'unused.png']);
  });

  it('what does not fit the count or size is skipped', () => {
    const list = [{ size: 5 }, { size: 500 }, { size: 6 }, { size: 7 }];
    const { take, skipped } = planAttachments(list, 2, 100);
    expect(take).toEqual([{ size: 5 }, { size: 6 }]);
    expect(skipped).toEqual([{ size: 500 }, { size: 7 }]);
  });
});
