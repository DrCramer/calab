import type { Dict, Locale } from '@/i18n';
import { getHome, type FooterLinkId } from '@/i18n/home';
import { localePath } from '@/i18n/locales';
import { CONTACT_FORM_URL, GPTUNNEL_URL, REPO_URL, repoFile } from '@/lib/site';
import { CookieSettingsButton } from './cookie-preferences';
import { Container } from './ui';

const href = (id: FooterLinkId, locale: Locale): string => {
  const home = localePath(locale);
  const at: Record<FooterLinkId, string> = {
    features: localePath(locale, 'features/'),
    telephony: `${home}#telephony`,
    pricing: `${home}#pricing`,
    download: `${home}#download`,
    changelog: repoFile('CHANGELOG.md'),
    docs: localePath(locale, 'docs/'),
    botApi: localePath(locale, 'docs/bots/'),
    mcp: localePath(locale, 'docs/bots/mcp/'),
    github: REPO_URL,
    contacts: localePath(locale, 'legal/contacts/'),
    support: 'mailto:support@calab.io',
    form: CONTACT_FORM_URL,
    offer: localePath(locale, 'legal/offer/'),
    terms: localePath(locale, 'legal/terms/'),
    privacy: localePath(locale, 'legal/privacy/'),
    payments: localePath(locale, 'legal/payments/'),
    cookies: localePath(locale, 'legal/cookies/'),
    license: repoFile('LICENSE'),
    trademarks: repoFile('TRADEMARKS.md'),
  };
  return at[id];
};

/** Footer (§4.14): four columns — product, developers, company, documents — then the company details. */
export function Footer({ t, locale }: { t: Dict['footer']; locale: Locale }) {
  const columns = getHome(locale).footer.columns;
  return (
    <footer className="site-footer">
      <Container>
        <div className="footer-grid">
          <a href={localePath(locale)} className="footer-brand" aria-label="Calab">
            <img className="footer-wordmark" src="/calab-wordmark.svg" width={311} height={87} alt="Calab" loading="lazy" />
          </a>
          {columns.map((col, i) => (
            <nav key={col.title} aria-label={col.title} className="footer-col">
              <h2 className="footer-title">{col.title}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.id}>
                    <a href={href(l.id, locale)}>{l.label}</a>
                  </li>
                ))}
                {i === columns.length - 1 && (
                  <li>
                    <CookieSettingsButton>{t.cookieSettings}</CookieSettingsButton>
                  </li>
                )}
              </ul>
            </nav>
          ))}
        </div>
        <div className="footer-legal">
          {locale === 'ru' ? (
            <div lang="ru">
              <p>ООО «Громтех» · ИНН 5027346848 · КПП 502701001 · ОГРН 1265000035420</p>
            </div>
          ) : (
            <div lang="en">
              <p>OOO Gromtech · INN 5027346848 · KPP 502701001 · OGRN 1265000035420</p>
            </div>
          )}
          {/* Required attribution (BSL 1.1 / NOTICE): never translated. */}
          <p className="footer-attribution">
            © 2026 GPTunneL ·{' '}
            <a href={GPTUNNEL_URL} lang="en">
              Powered by GPTunneL
            </a>
          </p>
        </div>
      </Container>
    </footer>
  );
}
