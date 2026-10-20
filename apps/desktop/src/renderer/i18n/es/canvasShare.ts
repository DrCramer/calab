import type { ruCanvasShare } from '../ru/canvasShare';
import type { DictShape } from '../types';

/** The public read-only link of a canvas (ADR-0115 wave 5). Same keys and placeholders as ru/canvasShare.ts. */
export const esCanvasShare: DictShape<typeof ruCanvasShare> = {
  'canvasShare.tabs': 'Acceso al lienzo',
  'canvasShare.tab.access': 'Acceso',
  'canvasShare.tab.link': 'Enlace',
  'canvasShare.link.on': 'Acceso por enlace',
  'canvasShare.link.hint': 'Cualquiera con el enlace ve el lienzo sin iniciar sesión, pero no puede editarlo ni ver quién está en él',
  'canvasShare.link.private': 'Un lienzo privado no se puede abrir por enlace. Desactiva «Solo personas seleccionadas» en la pestaña «Acceso» para activar el enlace.',
  'canvasShare.link.views': 'Vistas: {n}',
  'canvasShare.err.link': 'No se pudo cambiar el enlace',
  'canvasShare.public.readOnly': 'Solo lectura',
  'canvasShare.public.gone': 'Lienzo no disponible',
  'canvasShare.public.goneText': 'El enlace fue revocado o caducó, o el lienzo se hizo privado o se eliminó.',
};
