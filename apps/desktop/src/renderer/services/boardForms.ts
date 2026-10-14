import {
  BoardFormUploadResponseSchema,
  BoardFormResponseSchema,
  CreateBoardFormRequestSchema,
  FormSubmissionResponseSchema,
  ListBoardFormsResponseSchema,
  PreviewBoardFormRequestSchema,
  PublicBoardFormResponseSchema,
  SubmitBoardFormRequestSchema,
  UpdateBoardFormRequestSchema,
  type BoardFormDefinition,
  type BoardFormAnswer,
  type BoardFormUploadResponse,
} from '@calaba/protocol';
import { body, call, callEmpty } from '../lib/api/client';
import { uploadInto } from '../lib/api/endpoints';
const enc = encodeURIComponent;
export const boardForms = {
  list: (id: string) => call('GET', `/api/boards/${enc(id)}/forms`, ListBoardFormsResponseSchema),
  create: (id: string, definition: BoardFormDefinition) =>
    call('POST', `/api/boards/${enc(id)}/forms`, BoardFormResponseSchema, body(CreateBoardFormRequestSchema, { definition })),
  update: (id: string, fid: string, definition: BoardFormDefinition, revision: number) =>
    call(
      'PUT',
      `/api/boards/${enc(id)}/forms/${enc(fid)}`,
      BoardFormResponseSchema,
      body(UpdateBoardFormRequestSchema, { definition, revision }),
    ),
  remove: (id: string, fid: string) => callEmpty('DELETE', `/api/boards/${enc(id)}/forms/${enc(fid)}`),
  preview: (id: string, definition: BoardFormDefinition, answers: BoardFormAnswer[]) =>
    call(
      'POST',
      `/api/boards/${enc(id)}/forms/preview`,
      FormSubmissionResponseSchema,
      body(PreviewBoardFormRequestSchema, { definition, answers }),
    ),
  get: (code: string, signed: boolean) => call('GET', `/api/${signed ? '' : 'public/'}forms/${enc(code)}`, PublicBoardFormResponseSchema),
  submit: (code: string, signed: boolean, revision: number, nonce: string, answers: BoardFormAnswer[]) =>
    call(
      'POST',
      `/api/${signed ? '' : 'public/'}forms/${enc(code)}/submissions`,
      FormSubmissionResponseSchema,
      body(SubmitBoardFormRequestSchema, { revision, nonce, answers }),
    ),
  /** A staged file of a FILE field (ADR-0064 v2); the upload id is the answer value. */
  upload: (code: string, signed: boolean, fieldId: string, file: File, onProgress: (fraction: number) => void) =>
    uploadInto<typeof BoardFormUploadResponseSchema, BoardFormUploadResponse>(
      `/api/${signed ? '' : 'public/'}forms/${enc(code)}/files?field=${enc(fieldId)}`,
      BoardFormUploadResponseSchema,
      (r) => (r.uploadId ? r : undefined),
      file,
      file.name,
      onProgress,
    ),
};
export const formPageCode = (): string | null =>
  import.meta.env.VITE_PLATFORM === 'web' ? (/^\/f\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null) : null;
