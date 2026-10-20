import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — Canvas on the phone (ADR-0113 §5, editing — ADR-0114 wave 5b). Same keys and placeholders as ru/canvasPhone.ts. */
export const zhCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': '你只能查看此画布，可平移和缩放。',
  'canvasPhone.edit': '编辑',
  'canvasPhone.done': '完成',
  'canvasPhone.editHint': '点按对象即可选中，拖动已选中的对象可移动它；双指始终用于平移和缩放。长按空白处可打开菜单。',
  'canvasPhone.editMode': '编辑模式',
  'canvasPhone.dismiss': '知道了',
  'canvasPhone.others': { other: '画布上还有 {n} 人' },
  'canvasPhone.loadFailed': '无法加载画布',
  'canvasPhone.updated': '{when}修改',
};
