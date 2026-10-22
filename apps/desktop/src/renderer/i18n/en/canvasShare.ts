import type { ruCanvasShare } from '../ru/canvasShare';
import type { DictShape } from '../types';

/** The public read-only link of a canvas (ADR-0116 wave 5). Same keys and placeholders as ru/canvasShare.ts. */
export const enCanvasShare: DictShape<typeof ruCanvasShare> = {
  'canvasShare.tabs': 'Canvas access',
  'canvasShare.tab.access': 'Access',
  'canvasShare.tab.link': 'Link',
  'canvasShare.link.on': 'Access by link',
  'canvasShare.link.hint': 'Anyone with the link sees the canvas without signing in, but cannot edit it or see who is on it',
  'canvasShare.link.private': 'A private canvas cannot be opened by link. Turn off “Selected people only” on the “Access” tab to switch the link on.',
  'canvasShare.link.views': 'Views: {n}',
  'canvasShare.err.link': 'Could not change the link',
  'canvasShare.public.readOnly': 'View only',
  'canvasShare.public.gone': 'Canvas unavailable',
  'canvasShare.public.goneText': 'The link was revoked or expired, or the canvas was made private or deleted.',
  'canvasShare.public.busy': 'Too many viewers from your network, try again later',
};
