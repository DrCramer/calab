import type { ruAnnot } from '../ru/annot';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — laser pointer and pen over a stream (ADR-0028). */
export const zhAnnot: DictShape<typeof ruAnnot> = {
  'annot.tools': '在直播画面上标注',
  'annot.pointer': '激光笔',
  'annot.pen': '画笔',
  'annot.color': '颜色',
  'annot.clear': '清除',
  'annot.clearAll': '清除观众的标注',
  'annot.allowViewers': '允许观众标注',
  'annot.hint.screen': '绘制内容显示在你的屏幕上，不会进入直播',
  'annot.hint.preview': '绘制内容显示在你的直播预览中',
  'annot.activity.pointer': '{name} 正在指示',
  'annot.activity.stroke': '{name} 正在绘制',
  'annot.showPreview': '显示',
  'annot.color.red': '红色',
  'annot.color.yellow': '黄色',
  'annot.color.green': '绿色',
  'annot.color.blue': '蓝色',
  'annot.color.purple': '紫色',
  'annot.color.white': '白色',
};
