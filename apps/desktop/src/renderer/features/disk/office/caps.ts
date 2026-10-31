import { OfficeCapability, type OfficeCapabilitiesResponse, type OfficeFormat } from '@calaba/protocol';
import { create as createStore } from 'zustand';

/**
 * What the office editor opens and how (ADR-0143 «Форматы»): the server's one map, asked once per
 * connection (GET /api/office/capabilities at READY: loadCaps.ts). The client keeps no list of its own: an
 * extension the server does not name opens as before. Off (or not asked yet) = nothing opens in
 * the editor and «Создать» has no office items.
 */
export type OfficeCap = 'edit' | 'view' | 'convert';

interface OfficeCaps {
  enabled: boolean;
  /** Lower-case extension → its entry of the server's map. */
  formats: Readonly<Record<string, OfficeFormat>>;
  /** The Document Server origin the editor's frame comes from. */
  docsUrl: string;
  maxSize: bigint;
  /** The editor's uiTheme for the app's dark and light themes (the operator's OFFICE_THEME_*). */
  themeDark: string;
  themeLight: string;
}

const OFF: OfficeCaps = { enabled: false, formats: {}, docsUrl: '', maxSize: 0n, themeDark: '', themeLight: '' };

export const useOfficeCaps = createStore<OfficeCaps>(() => OFF);

/** Applies a capabilities answer (also the e2e and unit tests' entry). */
export function setOfficeCaps(r: Pick<OfficeCapabilitiesResponse, 'enabled' | 'formats' | 'docsUrl' | 'maxSizeBytes' | 'themeDark' | 'themeLight'>): void {
  if (!r.enabled) {
    if (useOfficeCaps.getState().enabled) useOfficeCaps.setState(OFF, true);
    return;
  }
  const formats: Record<string, OfficeFormat> = {};
  for (const f of r.formats) if (f.extension) formats[f.extension.toLowerCase()] = f;
  useOfficeCaps.setState({ enabled: true, formats, docsUrl: r.docsUrl, maxSize: r.maxSizeBytes, themeDark: r.themeDark, themeLight: r.themeLight }, true);
}

const extOf = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** The server's entry for this file name, null when the editor does not open it (or is off). */
export function officeFormat(name: string): OfficeFormat | null {
  const s = useOfficeCaps.getState();
  if (!s.enabled) return null;
  return s.formats[extOf(name)] ?? null;
}

const WARMABLE = new Set(['word', 'cell', 'slide']);

/** The editors (documentType) these files open in, sorted and joined: 'cell,word' (a primitive for a selector). */
export function officeKindsOf(names: readonly string[]): string {
  const kinds = new Set<string>();
  for (const n of names) {
    const t = officeFormat(n)?.documentType ?? '';
    if (WARMABLE.has(t)) kinds.add(t);
  }
  return [...kinds].sort().join(',');
}

export function officeCapability(name: string): OfficeCap | null {
  switch (officeFormat(name)?.capability) {
    case OfficeCapability.EDIT:
      return 'edit';
    case OfficeCapability.VIEW:
      return 'view';
    case OfficeCapability.CONVERT:
      return 'convert';
    default:
      return null;
  }
}

/** `docx` for «Старый.doc»; '' when «Сохранить как» does not apply. */
export function convertTarget(name: string): string {
  const f = officeFormat(name);
  return f?.capability === OfficeCapability.CONVERT ? f.convertTo : '';
}

/** The extensions «Создать» makes (the server's templates), when the editor edits them. */
export const CREATE_KINDS = ['docx', 'xlsx', 'pptx'] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];
