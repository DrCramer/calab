import { Check } from 'lucide-react';
import { localePath, type Locale } from '@/i18n';
import { getMcp } from '@/i18n/mcp';
import { Button, Container, SectionHeading } from './ui';

/**
 * Docs link: the MCP chapter of the bot SDK page (apps/landing/src/content/docs/<lang>/bots/sdk.md).
 * If a dedicated /docs/mcp/ page appears, change this one constant.
 */
const docsHref = (locale: Locale): string =>
  localePath(locale, 'docs/bots/sdk/') + (locale === 'ru' ? '#mcp-для-llm-клиентов' : '#mcp-for-llm-clients');

/** «MCP» (CBF-48, ADR-0114): static section, no motion, no client JS. */
export function McpSection({ locale }: { locale: Locale }) {
  const t = getMcp(locale);
  return (
    <section id="mcp" aria-labelledby="mcp-title" className="py-16 sm:py-24">
      <Container>
        <SectionHeading id="mcp-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        <ul className="mt-10 grid list-none gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {t.points.map((p) => (
            <li key={p.title} className="rounded-[20px] bg-card p-5 sm:p-6">
              <h3 className="text-[19px] leading-6 font-bold">{p.title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-pretty text-fg-2">{p.text}</p>
            </li>
          ))}
        </ul>
        <div className="mt-5 rounded-[20px] bg-card p-5 sm:p-7">
          <h3 className="text-[19px] leading-6 font-bold">{t.toolsTitle}</h3>
          <ul className="mt-4 grid list-none gap-x-8 gap-y-3 md:grid-cols-2">
            {t.tools.map((tool) => (
              <li key={tool.name} className="flex gap-3 text-[15px] leading-6">
                <Check aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-accent" strokeWidth={2.25} />
                <span className="min-w-0 text-pretty">
                  <code className="font-mono text-[14px] font-semibold">{tool.name}</code>
                  <span className="text-fg-2"> — {tool.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[14px] leading-5 text-pretty text-fg-2">{t.note}</p>
        </div>
        <div className="mt-8 flex justify-center">
          <Button href={docsHref(locale)} variant="secondary" className="w-full max-w-[320px] sm:w-auto">
            {t.docs}
          </Button>
        </div>
      </Container>
    </section>
  );
}
