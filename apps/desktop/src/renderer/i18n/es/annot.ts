import type { ruAnnot } from '../ru/annot';
import type { DictShape } from '../types';

/** Spanish UI strings — laser pointer and pen over a stream (ADR-0028). */
export const esAnnot: DictShape<typeof ruAnnot> = {
  'annot.tools': 'Dibujar en la transmisión',
  'annot.pointer': 'Puntero',
  'annot.pen': 'Lápiz',
  'annot.color': 'Color',
  'annot.clear': 'Borrar',
  'annot.clearAll': 'Borrar los dibujos de los espectadores',
  'annot.allowViewers': 'Los espectadores pueden dibujar',
  'annot.hint.screen': 'Los dibujos aparecen sobre tu pantalla, no en la transmisión',
  'annot.hint.preview': 'Los dibujos se ven en la vista previa de tu transmisión',
  'annot.activity.pointer': '{name} está señalando',
  'annot.activity.stroke': '{name} está dibujando',
  'annot.showPreview': 'Mostrar',
  'annot.color.red': 'Rojo',
  'annot.color.yellow': 'Amarillo',
  'annot.color.green': 'Verde',
  'annot.color.blue': 'Azul',
  'annot.color.purple': 'Morado',
  'annot.color.white': 'Blanco',
};
