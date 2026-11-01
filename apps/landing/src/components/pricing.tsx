import { ChevronDown, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { localePath, type Dict, type Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { APP_URL, repoFile } from '@/lib/site';
import { PlanCta, PlanMonth, PlanPrice, PricesBar } from './plan-prices';
import { Button, Section, SectionHeading } from './ui';

const KEY_ROWS = ['members', 'room', 'boards', 'canvases'] as const;

const PLAN_IDS = ['free', 'team', 'business', 'enterprise'] as const;
/** Business quotas carry a «*»: raised on request (owner, 24.10), footnote `quotaNote` under the cards. */
const BUSINESS_COL = 2;
const QUOTA_ROWS: ReadonlySet<string> = new Set([
  'room', 'members', 'streams', 'cameras', 'files', 'bots', 'boards', 'tempRooms', 'wiki', 'canvases', 'forms',
]);
const quota = (row: string, col: number): boolean => col === BUSINESS_COL && QUOTA_ROWS.has(row);
type PlanId = (typeof PLAN_IDS)[number];
const paid = (id: PlanId): id is 'team' | 'business' => id === 'team' || id === 'business';
type RowId = keyof Dict['pricing']['table']['rows'];
const ROW_IDS = Object.keys({
  room: 0,
  members: 0,
  audio: 0,
  video: 0,
  streams: 0,
  cameras: 0,
  files: 0,
  bots: 0,
  stickers: 0,
  boards: 0,
  tempRooms: 0,
  wiki: 0,
  canvases: 0,
  calendar: 0,
  caldav: 0,
  musician: 0,
  checklists: 0,
  automations: 0,
  forms: 0,
  mail: 0,
  approvals: 0,
  webapps: 0,
  sip: 0,
  ai: 0,
  webhook: 0,
  sso: 0,
  whitelabel: 0,
  onprem: 0,
  support: 0,
  price: 0,
} satisfies Record<RowId, 0>) as RowId[];


const CTA: Record<PlanId, (t: Dict['pricing'], locale: Locale) => ReactNode> = {
  free: (t) => (
    <div className="flex gap-2">
      <Button href="#download" size="md" className="min-w-0 flex-1 px-3">
        {t.cta.download}
      </Button>
      <Button href={APP_URL} variant="secondary" size="md" className="min-w-0 flex-1 px-3">
        {t.cta.web}
      </Button>
    </div>
  ),
  team: (t, locale) => <PlanCta locale={locale} t={t.live} plan="team" />,
  business: (t, locale) => <PlanCta locale={locale} t={t.live} plan="business" />,
  enterprise: (t) => (
    <Button href={repoFile('COMMERCIAL-LICENSE.md')} variant="secondary" size="md" className="w-full">
      {t.cta.license}
    </Button>
  ),
};

/** A table value: '∞', '—' and '✓' are symbols for the eye and words for a screen reader. */
function Cell({ value, t, star = false }: { value: string; t: Dict['pricing']['table']; star?: boolean }) {
  if (star) {
    return (
      <>
        <Cell value={value} t={t} />
        <sup aria-hidden="true" className="ml-0.5 text-fg-2">*</sup>
      </>
    );
  }
  if (value === '✗') {
    return (
      <>
        <Lock aria-hidden="true" className="size-4 text-fg-2" strokeWidth={1.75} />
        <span className="sr-only">{t.locked}</span>
      </>
    );
  }
  const spoken = { '∞': t.unlimited, '—': t.no, '✓': t.yes }[value];
  if (!spoken) return <>{value}</>;
  return (
    <>
      <span aria-hidden="true" className={value === '∞' ? 'text-[19px] leading-none' : value === '—' ? 'text-fg-2' : 'text-accent'}>
        {value}
      </span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}

/**
 * Plans (README «Тарифы», ADR-0024; Free · Team · Business · Enterprise = own server): four plan cards with their four
 * key limits (Free is where to start); the full comparison table from md up sits in a closed native <details> (§4.10);
 * on phones the table would need a sideways scroll, so each card carries its own values in a <details> instead (no JS).
 */
export function Pricing({ t, locale }: { t: Dict['pricing']; locale: Locale }) {
  const tb = t.table;
  const h = getHome(locale).pricing;
  return (
    <Section id="pricing" labelledBy="pricing-title">
      <SectionHeading id="pricing-title" title={t.title} accent={t.accent} lead={t.lead} sticker="pricing" />
      <PricesBar locale={locale} t={t.live} />
      <ul className="swipe-sm mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PLAN_IDS.map((id, col) => {
          const plan = t.plans[id];
          // Team is the highlighted plan (owner, 24.10).
          const popular = id === 'team';
          return (
            <li
              key={id}
              className={'card plan-card' + (popular ? ' plan-card-popular' : '')}
            >
              {popular && (
                <p className="plan-popular">
                  {t.popular}
                </p>
              )}
              <h3 id={`plan-${id}`} className="text-[17px] leading-6 font-semibold">
                {plan.name}
              </h3>
              <p className="mt-1 text-[24px] leading-8 font-semibold tracking-tight">
                {paid(id) ? <PlanPrice plan={id} locale={locale} /> : plan.price}
              </p>
              {paid(id) && (
                <>
                  <p className="mt-1 text-[14px] leading-5 text-fg-2">{t.perSeatDay}</p>
                  <PlanMonth plan={id} locale={locale} t={t.live} className="mt-1 text-[14px] leading-5 text-fg-2" />
                </>
              )}
              <p className="mt-1 text-[14px] leading-5 text-pretty text-fg-2">{plan.note}</p>
              <dl className="plan-keys">
                {KEY_ROWS.map((row) => (
                  <div key={row}>
                    <dt>{h.rows[row]}</dt>
                    <dd>
                      <Cell value={tb.cells[row][col] ?? ''} t={tb} star={quota(row, col)} />
                    </dd>
                  </div>
                ))}
              </dl>
              <details className="group mt-4 md:hidden">
                <summary className="flex min-h-11 cursor-pointer items-center justify-between rounded-md text-[15px] font-medium text-accent-text">
                  {tb.details}
                  <ChevronDown aria-hidden="true" className="chevron size-5 motion-safe:transition-transform" strokeWidth={1.75} />
                </summary>
                <dl className="divide-y divide-line border-t border-line text-[15px] leading-6">
                  {ROW_IDS.map((row) => (
                    <div key={row} className="flex justify-between gap-4 py-2">
                      <dt className="text-fg-2">{tb.rows[row]}</dt>
                      <dd className="text-right font-medium">
                        {row === 'price' && paid(id) ? <PlanPrice plan={id} locale={locale} /> : <Cell value={tb.cells[row][col] ?? ''} t={tb} star={quota(row, col)} />}
                        {row === 'price' && paid(id) && (
                          <span className="block text-[12px] font-normal text-fg-2">{t.perSeatDay}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
              <div className="mt-auto pt-6">{CTA[id](t, locale)}</div>
            </li>
          );
        })}
      </ul>
      <div className="pricing-notes">
        <div className="grid gap-2">
          <p className="caption">
            {t.billingNote}{' '}
            <Link href={localePath(locale, 'legal/offer/')} className="link">{t.offerLink}</Link>
          </p>
          <p className="caption">* {t.quotaNote}</p>
        </div>
        <p className="caption pricing-license">
          {t.license}{' '}
          <a href={repoFile('LICENSE')} className="link">
            {t.licenseLink}
          </a>
        </p>
      </div>
      <details className="compare mt-6 hidden md:block">
        <summary className="compare-summary">
          {h.compare}
          <ChevronDown aria-hidden="true" className="chevron size-5 motion-safe:transition-transform" strokeWidth={1.75} />
        </summary>
        <div className="compare-table">
        <table className="w-full table-fixed border-collapse text-[15px] leading-6">
          <caption className="sr-only">{tb.caption}</caption>
          <colgroup>
            <col className="w-[24%]" />
            <col span={4} />
          </colgroup>
          <thead className="bg-bg-alt">
            <tr>
              <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold tracking-wide text-fg-2 uppercase">
                {tb.feature}
              </th>
              {PLAN_IDS.map((id) => (
                <th key={id} scope="col" className={'px-4 py-3 text-left font-semibold' + (id === 'free' ? ' text-accent-text' : '')}>
                  {t.plans[id].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROW_IDS.map((row) => (
              <tr key={row}>
                <th scope="row" className="px-4 py-3 text-left align-top font-normal text-fg-2">
                  {tb.rows[row]}
                </th>
                {tb.cells[row].map((v, col) => (
                  <td key={PLAN_IDS[col]} className="px-4 py-3 align-top text-pretty">
                    {row === 'price' && (col === 1 || col === 2) ? (
                      <PlanPrice plan={col === 1 ? 'team' : 'business'} locale={locale} />
                    ) : (
                      <Cell value={v} t={tb} star={quota(row, col)} />
                    )}
                    {row === 'price' && (col === 1 || col === 2) && (
                      <span className="block text-[12px] text-fg-2">{t.perSeatDay}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </details>
    </Section>
  );
}
