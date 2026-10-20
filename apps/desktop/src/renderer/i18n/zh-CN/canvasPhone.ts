import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — Canvas on the phone (ADR-0113 §5: view only). Same keys and placeholders as ru/canvasPhone.ts. */
export const zhCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': '暂不支持在手机上编辑画布，只能平移和缩放。请在电脑上打开后修改。',
  'canvasPhone.dismiss': '知道了',
  'canvasPhone.others': { other: '画布上还有 {n} 人' },
  'canvasPhone.loadFailed': '无法加载画布',
  'canvasPhone.updated': '{when}修改',
};
