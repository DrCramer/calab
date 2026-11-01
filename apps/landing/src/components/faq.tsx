import { Plus } from 'lucide-react';
import type { Dict, Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { rich } from '@/lib/rich';
import { CONTACT_FORM_URL } from '@/lib/site';
import { Section, SectionHeading } from './ui';

const ORDER = ['server', 'identity', 'canvas', 'ai', 'mail', 'mobile', 'recording', 'sip', 'security', 'firewall', 'enterprise', 'buy'] as const;

/** FAQ (§4.12): native <details> (works without JS), two columns from 1024 px, questions in the text face. */
export function Faq({ t, locale }: { t: Dict['faq']; locale: Locale }) {
  const extra = getHome(locale).faq.items;
  const items = { ...t.items, ...extra };
  const contact = (
    <a href={CONTACT_FORM_URL} className="link">
      {t.contactLink}
    </a>
  );
  return (
    <Section id="faq" labelledBy="faq-title">
      <SectionHeading id="faq-title" title={t.title} lead={t.lead} sticker="faq" />
      <div className="faq-grid">
        {ORDER.map((id) => (
          <details key={id} className="faq-card">
            <summary className="faq-question">
              <h3>{items[id].q}</h3>
              <span className="faq-toggle" aria-hidden="true">
                <Plus size={20} strokeWidth={1.75} />
              </span>
            </summary>
            <div className="faq-answer">
              <p>{rich(items[id].a, { contact })}</p>
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
}
