import { describe, expect, it } from 'vitest';
import { enCanvasPhone } from './en/canvasPhone';
import { esCanvasPhone } from './es/canvasPhone';
import { ruCanvasPhone } from './ru/canvasPhone';
import { zhCanvasPhone } from './zh-CN/canvasPhone';
import { en } from './en';
import { es } from './es';
import { ru } from './ru';
import { zhCN } from './zh-CN';

/** The phone viewer's strings (features/canvas/PhoneCanvas.tsx, view/PhoneChrome.tsx) exist in all four locales and are registered. */
const KEYS = Object.keys(ruCanvasPhone);

describe('canvasPhone strings', () => {
  it('have the same keys in ru, en, es and zh-CN', () => {
    for (const d of [enCanvasPhone, esCanvasPhone, zhCanvasPhone]) expect(Object.keys(d).sort()).toEqual([...KEYS].sort());
    expect(KEYS).toEqual(expect.arrayContaining(['canvasPhone.note', 'canvasPhone.dismiss', 'canvasPhone.others', 'canvasPhone.loadFailed', 'canvasPhone.updated']));
  });

  it('are part of every locale dictionary', () => {
    for (const d of [ru, en, es, zhCN] as Array<Record<string, unknown>>) for (const k of KEYS) expect(d[k], k).toBeTruthy();
  });

  it('keep their placeholders', () => {
    for (const d of [ruCanvasPhone, enCanvasPhone, esCanvasPhone, zhCanvasPhone]) {
      expect(d['canvasPhone.updated']).toContain('{when}');
      for (const form of Object.values(d['canvasPhone.others'])) expect(form).toContain('{n}');
    }
  });
});
