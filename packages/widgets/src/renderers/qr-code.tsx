import { cn } from '@openbots/ui';
import { toString as qrSvg } from 'qrcode';
import { useEffect, useState } from 'react';

/** A QR code of `value`, drawn as an SVG image on white so a phone camera reads it in dark mode too. */
export function QrCode({
  value,
  alt,
  className,
}: {
  value: string;
  alt: string;
  className?: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void qrSvg(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (text) => current && setSvg(text),
      () => current && setSvg(null),
    );
    return () => {
      current = false;
    };
  }, [value]);

  if (!svg) return null;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={alt}
      className={cn('rounded-md bg-white p-2', className)}
    />
  );
}
