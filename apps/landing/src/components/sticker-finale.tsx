import type { Locale } from '@/i18n';
import { CursorStickerTrail } from './cursor-sticker-trail';
import { Button } from './ui';

const copy: Record<Locale, readonly [string, string]> = {
  ru: ['Ну что, на связи?', 'Начать разговор'],
  en: ['Ready to connect?', 'Start a conversation'],
  es: ['¿Nos conectamos?', 'Iniciar conversación'],
  zh: ['准备好连接了吗？', '开始交流'],
};

/** The finale (§4.13, unchanged): the big question, the kinetic button and the cursor stickers. */
export function StickerFinale({ locale }: { locale: Locale }) {
  const t = copy[locale];
  // The part after the comma in the accent (owner, 24.10); a question without a comma stays one colour.
  const m = /^(.*?[,，]\s*)(.+)$/.exec(t[0]);
  const head = m ? m[1] : t[0];
  const tail = m ? m[2] : '';
  return (
    <section className="sticker-finale section-quiet" aria-labelledby="finale-title">
      <div className="finale-copy">
        <h2 id="finale-title" className="h2 finale-title">
          {head}
          {tail && <span className="text-accent-text">{tail}</span>}
        </h2>
        <Button href="#download" variant="kinetic">
          {t[1]}
        </Button>
      </div>
      <CursorStickerTrail />
    </section>
  );
}
