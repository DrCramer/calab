// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { DiskItemSchema } from '@calaba/protocol';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it, vi } from 'vitest';
import { useDisk } from '../../stores/disk';
import { DiskViewDialog } from './DiskViewer';

const { own, external } = vi.hoisted(() => ({ own: vi.fn((href: string) => href.startsWith('https://app.test/')), external: vi.fn() }));
vi.mock('../../services/links', () => ({ openOwnLink: own, shareOrigin: () => 'https://app.test' }));
vi.mock('../../platform', () => ({ platform: {
  kind: 'web', apiBase: '', app: { log: vi.fn(), openExternal: external },
  apiFetch: () => Promise.resolve(new Response('[Task](https://app.test/t/DEV-1) and [Outside](https://external.test/)')),
} }));
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

it('Disk Markdown routes internal links and opens external links synchronously', async () => {
  useDisk.setState({ items: { doc: create(DiskItemSchema, { id: 'doc', name: 'links.md', file: { id: 'f', name: 'links.md', mime: 'text/markdown', size: 80n } }) } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const popup = vi.spyOn(window, 'open').mockImplementation(() => null);
  try {
    await act(async () => { root.render(createElement(DiskViewDialog, { itemId: 'doc', siblings: [], onClose: () => undefined })); await Promise.resolve(); });
    const task = document.querySelector<HTMLAnchorElement>('a[href="https://app.test/t/DEV-1"]');
    expect(task).not.toBeNull(); act(() => task?.click());
    expect(own).toHaveBeenCalledWith('https://app.test/t/DEV-1');
    expect(external).not.toHaveBeenCalled(); expect(popup).not.toHaveBeenCalled();
    act(() => document.querySelector<HTMLAnchorElement>('a[href="https://external.test/"]')?.click());
    expect(external).toHaveBeenCalledWith('https://external.test/');
  } finally { act(() => root.unmount()); host.remove(); popup.mockRestore(); }
});
