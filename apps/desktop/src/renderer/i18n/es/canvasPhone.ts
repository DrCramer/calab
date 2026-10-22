import type { ruCanvasPhone } from '../ru/canvasPhone';
import type { DictShape } from '../types';

/** Spanish UI strings — Canvas on the phone (ADR-0115 §5, editing — ADR-0116 wave 5b). Same keys and placeholders as ru/canvasPhone.ts. */
export const esCanvasPhone: DictShape<typeof ruCanvasPhone> = {
  'canvasPhone.note': 'Solo puedes ver este lienzo: puedes desplazarte y hacer zoom.',
  'canvasPhone.edit': 'Editar',
  'canvasPhone.done': 'Listo',
  'canvasPhone.editHint': 'Toca un objeto para seleccionarlo; arrastra el seleccionado para moverlo. Con dos dedos siempre te desplazas y haces zoom. Mantén pulsado un espacio vacío para ver el menú.',
  'canvasPhone.editMode': 'Modo de edición',
  'canvasPhone.tools': 'Herramientas',
  'canvasPhone.plus': 'Insertar',
  'canvasPhone.shapes': 'Formas',
  'canvasPhone.armed.sticky': 'Toca el lienzo para poner una nota',
  'canvasPhone.armed.text': 'Toca el lienzo para escribir texto',
  'canvasPhone.armed.shape': 'Toca el lienzo para poner la forma',
  'canvasPhone.armed.connector': 'Arrastra de un objeto a otro',
  'canvasPhone.armed.comment': 'Toca un objeto o el lienzo para dejar un comentario',
  'canvasPhone.multi': 'Seleccionar varios',
  'canvasPhone.multiHint': 'Toca los objetos para seleccionarlos',
  'canvasPhone.selected': { one: '{n} seleccionado', many: '{n} seleccionados', other: '{n} seleccionados' },
  'canvasPhone.menu': 'Menú del lienzo',
  'canvasPhone.menuClose': 'Cerrar el menú',
  'canvasPhone.menu.paste': 'Pegar',
  'canvasPhone.menu.text': 'Texto aquí',
  'canvasPhone.menu.templates': 'Plantilla…',
  'canvasPhone.editText': 'Editar texto',
  'canvasPhone.textDone': 'Listo',
  'canvasPhone.dismiss': 'Entendido',
  'canvasPhone.others': { one: '{n} más en el lienzo', many: '{n} más en el lienzo', other: '{n} más en el lienzo' },
  'canvasPhone.loadFailed': 'No se pudieron cargar los lienzos',
  'canvasPhone.updated': 'editado {when}',
};
