import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** English UI strings — Canvas on the phone (ADR-0113 §5: view only). Same keys and placeholders as ru/canvasPhone.ts. */
export const enCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': 'Editing a canvas on the phone is not available yet — you can pan and zoom. Open it on a computer to make changes.',
  'canvasPhone.dismiss': 'Got it',
  'canvasPhone.others': { one: '{n} more on the canvas', other: '{n} more on the canvas' },
  'canvasPhone.loadFailed': 'Could not load the canvases',
  'canvasPhone.updated': 'edited {when}',
};
