import type { ruCanvasShare } from '../ru/canvasShare';
import type { DictShape } from '../types';

/** The public read-only link of a canvas (ADR-0127 wave 5). Same keys and placeholders as ru/canvasShare.ts. */
export const zhCanvasShare: DictShape<typeof ruCanvasShare> = {
  'canvasShare.tabs': '画布访问权限',
  'canvasShare.tab.access': '访问权限',
  'canvasShare.tab.link': '链接',
  'canvasShare.link.on': '通过链接访问',
  'canvasShare.link.hint': '任何拥有链接的人无需登录即可查看画布，但不能编辑，也看不到谁在画布上',
  'canvasShare.link.private': '私密画布无法通过链接打开。在「访问权限」选项卡中关闭「仅限指定成员」后即可开启链接。',
  'canvasShare.link.views': '浏览次数：{n}',
  'canvasShare.err.link': '无法更改链接',
  'canvasShare.public.readOnly': '仅查看',
  'canvasShare.public.gone': '画布不可用',
  'canvasShare.public.goneText': '链接已被撤销或已过期，或画布已设为私密或已删除。',
  'canvasShare.public.busy': '来自您网络的观看者过多，请稍后再试',
};
