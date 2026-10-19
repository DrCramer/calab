import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** Spanish UI strings — Canvas on the phone (ADR-0107 §5: view only). Same keys and placeholders as ru/canvasPhone.ts. */
export const esCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': 'Aún no se puede editar el lienzo en el teléfono: puedes desplazarte y hacer zoom. Ábrelo en un ordenador para modificarlo.',
  'canvasPhone.dismiss': 'Entendido',
  'canvasPhone.others': { one: '{n} más en el lienzo', many: '{n} más en el lienzo', other: '{n} más en el lienzo' },
  'canvasPhone.loadFailed': 'No se pudieron cargar los lienzos',
  'canvasPhone.updated': 'editado {when}',
};
