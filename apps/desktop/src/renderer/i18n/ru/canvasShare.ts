/**
 * Russian UI strings — the public read-only link of a canvas (ADR-0116 wave 5): the «Ссылка» tab of «Доступ» and
 * the page `/c/{code}`. Flat dotted keys, `{param}` placeholders. The address, copy and expiry reuse `disk.link.*`.
 */
export const ruCanvasShare = {
  'canvasShare.tabs': 'Доступ к холсту',
  'canvasShare.tab.access': 'Доступ',
  'canvasShare.tab.link': 'Ссылка',
  'canvasShare.link.on': 'Доступ по ссылке',
  'canvasShare.link.hint': 'Любой, у кого есть ссылка, видит холст без входа, но не правит его и не видит участников',
  'canvasShare.link.private': 'Приватный холст нельзя открыть по ссылке. Снимите «Только выбранные» во вкладке «Доступ», чтобы включить ссылку.',
  'canvasShare.link.views': 'Просмотров: {n}',
  'canvasShare.err.link': 'Не удалось изменить ссылку',
  'canvasShare.public.readOnly': 'Только просмотр',
  'canvasShare.public.gone': 'Холст недоступен',
  'canvasShare.public.goneText': 'Ссылка отозвана или истекла, либо холст закрыли или удалили.',
  'canvasShare.public.busy': 'Слишком много зрителей с вашей сети, попробуйте позже',
};
