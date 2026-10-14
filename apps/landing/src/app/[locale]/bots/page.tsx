import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotsPage } from '@/components/bots';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { getDict, hreflangAlternates, isLocale, LOCALE_INFO, localePath } from '@/i18n';

type Params = Promise<{ locale: string }>;

const PAGE = 'bots/';

// Title, description and URLs of this page; icons, OG image and the rest come from [locale]/layout.tsx.
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { title, description } = getDict(locale).bots.meta;
  const path = localePath(locale, PAGE);
  return {
    title,
    description,
    alternates: { canonical: path, languages: hreflangAlternates(PAGE) },
    openGraph: {
      type: 'website',
      url: path,
      siteName: 'Calab',
      locale: LOCALE_INFO[locale].ogLocale,
      title,
      description,
      images: [{ url: `/og/${LOCALE_INFO[locale].lang}.png`, width: 1200, height: 630, alt: getDict(locale).meta.ogAlt }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [`/og/${LOCALE_INFO[locale].lang}.png`] },
  };
}

export default async function Bots({ params }: { params: Params }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDict(locale);
  return (
    <>
      <Header t={t.header} locale={locale} page={PAGE} />
      <main id="main">
        {/* Russian docs for ru; the English ones for every other locale (es/zh: English only). */}
        <BotsPage t={t.bots} docsUrl={localePath(locale, 'docs/bots/')} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </>
  );
}
