import type { FileMeta } from '@calaba/protocol';
import { useCallback, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { filePath, thumbnailPath } from '../lib/api/endpoints';
import { imageSteps } from '../lib/imageAttachment';
import { MediaImg } from './MediaImg';

/**
 * The preview of a picture attachment (lib/imageAttachment): its server thumbnail (`thumb`: a
 * sized variant of thumbnailPath, `hiDpiThumb` for 2× screens), else the original file; `onGone`
 * when no step loads (the caller turns the tile into a plain file). The steps are fixed per file:
 * a load error moves to the next one once, no retries, no timers.
 */
export function AttachmentImg({
  f,
  thumb,
  hiDpiThumb,
  onGone,
  ...rest
}: {
  f: Pick<FileMeta, 'id' | 'mime' | 'name' | 'size' | 'width' | 'height' | 'thumbnailUrl' | 'voice'>;
  thumb?: string | undefined;
  hiDpiThumb?: string | undefined;
  onGone?: () => void;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'onError'>): ReactNode {
  const [step, setStep] = useState(0);
  const steps = imageSteps(f);
  const kind = steps[step];
  const next = useCallback(() => {
    setStep((s) => s + 1);
  }, []);
  const gone = !kind;
  useEffect(() => {
    if (gone) onGone?.();
  }, [gone, onGone]);
  if (!kind) return <span className={rest.className} aria-hidden />;
  return kind === 'thumb' ? (
    <MediaImg key="thumb" path={thumb ?? thumbnailPath(f.id)} {...(hiDpiThumb ? { hiDpiPath: hiDpiThumb } : {})} onFail={next} {...rest} />
  ) : (
    <MediaImg key="original" path={filePath(f.id)} onFail={next} {...rest} />
  );
}
