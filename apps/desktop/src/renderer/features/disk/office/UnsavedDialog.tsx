import type { ReactNode } from 'react';
import { Button, Modal } from '../../../components/ui';
import { t } from '../../../i18n';
import { resolveUnsaved } from './fileTabs';

/** Closing a file tab with unsaved changes (ADR-0143): save and close, discard, or cancel. */
export function UnsavedDialog({ tabId, name, onClose }: { tabId: string; name: string; onClose: () => void }): ReactNode {
  const answer = (a: 'save' | 'discard' | 'cancel'): void => {
    resolveUnsaved(tabId, a);
    onClose();
  };
  return (
    <Modal
      open
      onClose={() => answer('cancel')}
      title={t('office.unsaved.title', { name })}
      closeButton={false}
      footer={
        <>
          <Button variant="secondary" onClick={() => answer('cancel')} data-testid="office-unsaved-cancel">
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => answer('discard')} data-testid="office-unsaved-discard">
            {t('office.unsaved.discard')}
          </Button>
          <Button onClick={() => answer('save')} autoFocus data-testid="office-unsaved-save">
            {t('office.unsaved.save')}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-muted">{t('office.unsaved.text', { name })}</p>
    </Modal>
  );
}
