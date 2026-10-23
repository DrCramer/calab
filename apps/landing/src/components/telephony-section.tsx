import { Bot } from 'lucide-react';
import { localePath, type Locale } from '@/i18n';
import { getTelephony } from '@/i18n/telephony';
import { Button, Container, SectionHeading } from './ui';

/** «Телефония» (CBF-86): static section, no motion, no client JS. Business and Enterprise (plans.TelephonyDisabled). */
export function TelephonySection({ locale }: { locale: Locale }) {
  const t = getTelephony(locale);
  return (
    <section id="telephony" aria-labelledby="telephony-title" className="py-16 sm:py-24">
      <Container>
        <SectionHeading id="telephony-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        <ul className="mt-10 grid list-none gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {t.points.map((p) => (
            <li key={p.title} className="rounded-[20px] bg-card p-5 sm:p-6">
              <h3 className="text-[19px] leading-6 font-bold">{p.title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{p.text}</p>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex gap-4 rounded-[20px] bg-card p-5 sm:p-7">
          <Bot aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-accent" strokeWidth={2} />
          <div className="min-w-0">
            <h3 className="text-[19px] leading-6 font-bold">{t.botTitle}</h3>
            <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{t.botText}</p>
          </div>
        </div>
        <p className="mt-5 text-[14px] leading-5 text-pretty text-fg-2">{t.plan}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href={localePath(locale, 'docs/telephony/')} variant="secondary" className="w-full max-w-[320px] sm:w-auto">
            {t.docs}
          </Button>
          <Button href={localePath(locale, 'docs/bots/')} variant="secondary" className="w-full max-w-[320px] sm:w-auto">
            {t.botDocs}
          </Button>
        </div>
      </Container>
    </section>
  );
}
