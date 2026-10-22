import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** Simplified Chinese UI strings — Canvas on the phone (ADR-0115 §5, editing — ADR-0116 wave 5b). Same keys and placeholders as ru/canvasPhone.ts. */
export const zhCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': '你只能查看此画布，可平移和缩放。',
  'canvasPhone.edit': '编辑',
  'canvasPhone.done': '完成',
  'canvasPhone.editHint': '点按对象即可选中，拖动已选中的对象可移动它；双指始终用于平移和缩放。长按空白处可打开菜单。',
  'canvasPhone.editMode': '编辑模式',
  'canvasPhone.tools': '工具',
  'canvasPhone.plus': '插入',
  'canvasPhone.shapes': '形状',
  'canvasPhone.armed.sticky': '点按画布放置便签',
  'canvasPhone.armed.text': '点按画布输入文字',
  'canvasPhone.armed.shape': '点按画布放置形状',
  'canvasPhone.armed.connector': '从一个对象拖到另一个对象',
  'canvasPhone.armed.comment': '点击对象或画布以留下评论',
  'canvasPhone.multi': '选择多个',
  'canvasPhone.multiHint': '点按对象进行选择',
  'canvasPhone.selected': { other: '已选 {n} 项' },
  'canvasPhone.menu': '画布菜单',
  'canvasPhone.menuClose': '关闭菜单',
  'canvasPhone.menu.paste': '粘贴',
  'canvasPhone.menu.text': '在此输入文字',
  'canvasPhone.menu.templates': '模板…',
  'canvasPhone.editText': '编辑文字',
  'canvasPhone.textDone': '完成',
  'canvasPhone.dismiss': '知道了',
  'canvasPhone.others': { other: '画布上还有 {n} 人' },
  'canvasPhone.loadFailed': '无法加载画布',
  'canvasPhone.updated': '{when}修改',
};
