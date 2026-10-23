import { create } from '@bufbuild/protobuf';
import { GetSipSettingsResponseSchema, type SipSettings } from '@calaba/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { Card, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { reportPlanError } from '../../services/plan';
import { toast } from '../../stores/toasts';

/*
 * Settings tab → «Запись звонков» (ADR-0131, CBF-81; MANAGE_INTEGRATIONS): two switches, each
 * saved at once (PUT …/sip/recording). The recordings go to the Disk (phone_recordings, by day)
 * for the workspace owner; the caller is warned by the voice menu's «Предупреждение о записи».
 * Off until the provider is saved; a server without the egress keeps the switches (a note says so).
 */

export function RecordingCard({ workspaceId, settings, settingsKey }: { workspaceId: string; settings: SipSettings; settingsKey: readonly unknown[] }): ReactNode {
  const qc = useQueryClient();
  const saved = !!settings.updatedAt;
  const save = useMutation({
    mutationFn: (v: { recordInbound: boolean; recordOutbound: boolean }) => api.sip.saveRecording(workspaceId, v),
    onSuccess: (r) => {
      if (r.settings) qc.setQueryData(settingsKey, create(GetSipSettingsResponseSchema, { settings: r.settings }));
      toast.info(t('pbx.saved'));
    },
    onError: (e) => {
      if (!reportPlanError(e, workspaceId)) toast.fail(e);
    },
  });
  // The switch shows the value being saved until the server answers.
  const inbound = save.isPending ? save.variables.recordInbound : settings.recordInbound;
  const outbound = save.isPending ? save.variables.recordOutbound : settings.recordOutbound;
  const note = !saved ? t('pbx.rec.notSaved') : !settings.recordingAvailable && (inbound || outbound) ? t('pbx.rec.unavailable') : null;
  return (
    <Card title={t('pbx.rec.title')} footer={t('pbx.rec.footer')}>
      <div className="flex flex-col px-3 py-1.5" data-testid="sip-recording">
        <Switch
          checked={inbound}
          onChange={(v) => save.mutate({ recordInbound: v, recordOutbound: outbound })}
          label={t('pbx.rec.inbound')}
          hint={t('pbx.rec.inboundHint')}
          disabled={!saved}
        />
        <Switch
          checked={outbound}
          onChange={(v) => save.mutate({ recordInbound: inbound, recordOutbound: v })}
          label={t('pbx.rec.outbound')}
          hint={t('pbx.rec.outboundHint')}
          disabled={!saved}
        />
        {note ? (
          <p className="py-1 text-caption text-muted" data-testid="sip-recording-note">
            {note}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
