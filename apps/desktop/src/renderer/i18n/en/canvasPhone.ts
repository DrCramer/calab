import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** English UI strings — Canvas on the phone (ADR-0113 §5, editing — ADR-0114 wave 5b). Same keys and placeholders as ru/canvasPhone.ts. */
export const enCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': 'You can only view this canvas — pan and zoom are available.',
  'canvasPhone.edit': 'Edit',
  'canvasPhone.done': 'Done',
  'canvasPhone.editHint': 'Tap an object to select it; drag the selected one to move it. Two fingers always pan and zoom. Long-press empty space for a menu.',
  'canvasPhone.editMode': 'Edit mode',
  'canvasPhone.tools': 'Tools',
  'canvasPhone.plus': 'Insert',
  'canvasPhone.shapes': 'Shapes',
  'canvasPhone.armed.sticky': 'Tap the canvas to place a sticky',
  'canvasPhone.armed.text': 'Tap the canvas to type text',
  'canvasPhone.armed.shape': 'Tap the canvas to place the shape',
  'canvasPhone.armed.connector': 'Drag from one object to another',
  'canvasPhone.multi': 'Select several',
  'canvasPhone.multiHint': 'Tap objects to select them',
  'canvasPhone.selected': { one: '{n} selected', other: '{n} selected' },
  'canvasPhone.menu': 'Canvas menu',
  'canvasPhone.menuClose': 'Close the menu',
  'canvasPhone.menu.paste': 'Paste',
  'canvasPhone.menu.text': 'Text here',
  'canvasPhone.menu.templates': 'Template…',
  'canvasPhone.editText': 'Edit text',
  'canvasPhone.dismiss': 'Got it',
  'canvasPhone.others': { one: '{n} more on the canvas', other: '{n} more on the canvas' },
  'canvasPhone.loadFailed': 'Could not load the canvases',
  'canvasPhone.updated': 'edited {when}',
};
