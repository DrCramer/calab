/**
 * Russian UI strings — «Холст» на телефоне (ADR-0113 §5, правка — ADR-0114 волна 5б). Flat dotted keys, `{param}` placeholders.
 */
export const ruCanvasPhone = {
  'canvasPhone.note': 'Вам доступен только просмотр этого холста — можно листать и приближать.',
  'canvasPhone.edit': 'Править',
  'canvasPhone.done': 'Готово',
  'canvasPhone.editHint': 'Коснитесь объекта, чтобы выделить; потяните выделенный — он переместится. Двумя пальцами — листать и приближать. Долгое касание по пустому месту — меню.',
  'canvasPhone.editMode': 'Режим правки',
  'canvasPhone.dismiss': 'Понятно',
  'canvasPhone.others': { one: 'ещё {n} на холсте', few: 'ещё {n} на холсте', many: 'ещё {n} на холсте', other: 'ещё {n} на холсте' },
  'canvasPhone.loadFailed': 'Не удалось загрузить холсты',
  'canvasPhone.updated': 'изменён {when}',
} as const;
