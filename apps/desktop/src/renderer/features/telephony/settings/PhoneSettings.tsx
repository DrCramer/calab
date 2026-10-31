import { SipExtensionKind, SipInboundMode, type SipSettings } from '@calaba/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { PhoneHeader } from '../../../components/PhoneHeader';
import { Spinner } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { planHas } from '../../../lib/plan';
import { phoneBack } from '../../../services/phoneNav';
import { useWorkspaces } from '../../../stores/workspaces';
import { useMayManageTelephony } from '../access';
import { useSipSettings } from './Connection';
import { ExtensionForm, GroupForm, MenuForm, WithExchange, menuCreated, type ExchangeLists } from './Exchange';
import { SET_PAGES, isSetPage, pushTelSettings, replaceTelSettings, type SetPage } from './pages';
import { retentionLabel } from './Policy';
import { clearPromptError, usePromptUpload } from './promptUpload';
import { useScheduleSummary } from './Schedule';
import { LoadFailed, Locked, PageBody, connectionText, connectionTone } from './SettingsSection';
import { DrillList, DrillRow, PhoneSettingsProvider, StateDot } from './ui';

/*
 * «Телефония → Настройки» on a phone (ADR-0137 §7): no tables — a drill-down list (rows 52 px with
 * the value and a chevron) whose every row is a screen of the stack: the forms with «Сохранить»
 * sticky at the bottom, the exchange's lists (rows 56 px) whose rows open their form screen. Below
 * the telephony plan each screen is under PlanLock, the list stays readable. Only the top screen is
 * mounted (MobileShell), so a form never keeps a hidden list alive.
 */

export function PhoneTelSettings({ workspaceId, page }: { workspaceId: string; page: string }): ReactNode {
  useLocale();
  const manage = useMayManageTelephony(workspaceId);
  useEffect(() => {
    // The right was taken away while a settings screen was open: back to the section's root.
    if (!manage) phoneBack();
  }, [manage]);
  if (!manage) return null;
  return (
    <PhoneSettingsProvider value>
      <section className="flex min-h-0 flex-1 flex-col bg-[var(--color-sheet-pane)]" data-testid="tel-phone-settings" data-page={page}>
        <Screen workspaceId={workspaceId} page={page} />
      </section>
    </PhoneSettingsProvider>
  );
}

function Screen({ workspaceId, page }: { workspaceId: string; page: string }): ReactNode {
  if (page === 'list') return <SettingsList workspaceId={workspaceId} />;
  if (isSetPage(page)) return <PageScreen workspaceId={workspaceId} page={page} />;
  const [kind, id = ''] = page.split(':');
  if (kind === 'ext' || kind === 'group' || kind === 'menu') return <FormScreen workspaceId={workspaceId} kind={kind} id={id} />;
  return null;
}

/** The pages that are one form (the sticky «Сохранить» needs the screen's full height). */
const FORM_PAGES: readonly SetPage[] = ['connection', 'inbound', 'schedule', 'policy'];

function PageScreen({ workspaceId, page }: { workspaceId: string; page: SetPage }): ReactNode {
  const def = SET_PAGES.find((p) => p.id === page);
  const q = useSipSettings(workspaceId, page === 'inbound');
  const allowed = useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
  const settings = q.data?.settings;
  const form = FORM_PAGES.includes(page) && allowed && !!settings && (page !== 'inbound' || settings.inboundAvailable);
  const body = q.isPending ? (
    <div className="grid place-items-center py-10">
      <Spinner />
    </div>
  ) : q.isError || !settings ? (
    <LoadFailed onRetry={() => void q.refetch()} />
  ) : (
    <Locked allowed={allowed}>
      <PageBody workspaceId={workspaceId} page={page} settings={settings} />
    </Locked>
  );
  return (
    <>
      <PhoneHeader title={def ? t(def.label) : ''} />
      {form ? body : <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-8 pt-4">{body}</div>}
    </>
  );
}

/** The root list: every page with its value («Работает ●», «По регистрации», «12», «1 год»). */
function SettingsList({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useSipSettings(workspaceId);
  const settings = q.data?.settings;
  return (
    <>
      <PhoneHeader title={t('tset.phoneTitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
        {q.isPending ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : q.isError || !settings ? (
          <LoadFailed onRetry={() => void q.refetch()} />
        ) : (
          <WithExchange workspaceId={workspaceId}>{(lists) => <ListRows settings={settings} lists={lists} />}</WithExchange>
        )}
      </div>
    </>
  );
}

function ListRows({ settings, lists }: { settings: SipSettings; lists: ExchangeLists }): ReactNode {
  const schedule = useScheduleSummary(settings.schedule, lists);
  const people = lists.exts.filter((e) => e.kind !== SipExtensionKind.GROUP).length;
  const rec = settings.recordInbound && settings.recordOutbound ? 'tset.rec.both' : settings.recordInbound ? 'tset.rec.in' : settings.recordOutbound ? 'tset.rec.out' : 'tset.rec.off';
  const inbound = !settings.inboundEnabled ? t('tset.in.off') : settings.inboundMode === SipInboundMode.REGISTER ? t('pbx.in.modeRegister') : t('pbx.in.modeDirect');
  const value = (p: SetPage): ReactNode => {
    switch (p) {
      case 'connection':
        return (
          <>
            <span className="truncate">{connectionText(settings)}</span>
            <StateDot tone={connectionTone(settings)} />
          </>
        );
      case 'inbound':
        return inbound;
      case 'schedule':
        return null;
      case 'numbers':
        return String(people);
      case 'groups':
        return String(lists.groups.length);
      case 'ivr':
        return String(lists.menus.length);
      case 'recording':
        return t(rec);
      case 'policy':
        return retentionLabel(settings.retentionMonths);
    }
  };
  return (
    <DrillList testId="tset-list">
      {SET_PAGES.map((p) => (
        <DrillRow key={p.id} icon={p.icon} label={t(p.label)} value={value(p.id)} {...(p.id === 'schedule' ? { sub: schedule } : {})} onOpen={() => pushTelSettings(p.id)} testId={`tset-row-${p.id}`} />
      ))}
    </DrillList>
  );
}

/** A number's, a group's or a menu's form as a screen; «Сохранить» / delete go back to the list. */
function FormScreen({ workspaceId, kind, id }: { workspaceId: string; kind: 'ext' | 'group' | 'menu'; id: string }): ReactNode {
  const qc = useQueryClient();
  const allowed = useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
  // A refusal of this menu's upload belongs to this screen: leaving it drops the line.
  useEffect(() => () => clearPromptError(usePromptUpload.getState().errMenu), []);
  return (
    <WithExchange workspaceId={workspaceId}>
      {(x) => {
        const isNew = id === 'new';
        const ext = kind === 'ext' && !isNew ? x.exts.find((e) => e.id === id) : undefined;
        const group = kind === 'group' && !isNew ? x.groups.find((g) => g.id === id) : undefined;
        const menu = kind === 'menu' && !isNew ? x.menus.find((m) => m.id === id) : undefined;
        const title =
          kind === 'ext' ? (ext ? t('tset.ext.title', { number: ext.number }) : t('pbx.ext.add')) : kind === 'group' ? (group ? group.name : t('pbx.group.add')) : menu ? menu.name : t('pbx.menu.add');
        // Deleted meanwhile (or by this screen): nothing to edit.
        const gone = !isNew && !ext && !group && !menu;
        const form =
          kind === 'ext' ? (
            <ExtensionForm workspaceId={workspaceId} exts={x.exts} {...(ext ? { ext } : {})} onDone={phoneBack} />
          ) : kind === 'group' ? (
            <GroupForm workspaceId={workspaceId} exts={x.exts} groups={x.groups} menus={x.menus} {...(group ? { group } : {})} onDone={phoneBack} />
          ) : (
            <MenuForm
              key={menu?.id ?? 'new'}
              workspaceId={workspaceId}
              exts={x.exts}
              groups={x.groups}
              menus={x.menus}
              {...(menu ? { menu } : {})}
              onDone={phoneBack}
              onCreated={(m, file, notice) => {
                // The new menu's screen becomes its edit screen; the chosen files upload there.
                replaceTelSettings(`menu:${m.id}`);
                menuCreated(qc, workspaceId, m, file, notice);
              }}
            />
          );
        return (
          <>
            <PhoneHeader title={title} />
            {gone ? (
              <p className="px-4 py-6 text-body text-muted">{t('tset.gone')}</p>
            ) : allowed ? (
              form
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
                <Locked allowed={false}>{form}</Locked>
              </div>
            )}
          </>
        );
      }}
    </WithExchange>
  );
}
