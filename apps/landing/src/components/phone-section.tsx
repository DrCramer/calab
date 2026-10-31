import type { Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { APP_URL } from '@/lib/site';
import { Badge, Button, Container, nb, Shot } from './ui';

/** «На телефоне» (§4.7): the web app on phones today, the native apps soon — one dark-blue panel, three phones. */
export function PhoneSection({ locale }: { locale: Locale }) {
  const t = getHome(locale);
  const p = t.phone;
  return (
    <section id="mobile" aria-labelledby="mobile-title" className="section">
      <Container>
        <div className="phone-panel">
          <div className="phone-copy">
            <Badge tone="solid" className="phone-corner">{p.soon}</Badge>
            <h2 id="mobile-title" className="h2">
              {p.title}
            </h2>
            <p className="lead">{nb(p.text)}</p>
            <p className="phone-soon">{nb(p.soonText)}</p>
            <Button href={APP_URL} variant="secondary" size="md" className="phone-open">
              {t.nav.openWeb}
            </Button>
          </div>
          <ul className="phone-shots">
            {p.shots.map((scene) => (
              <li key={scene}>
                <Shot scene={scene} locale={locale} alt={t.alts[scene]} sizes="(min-width: 1024px) 220px, 28vw" phone />
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
