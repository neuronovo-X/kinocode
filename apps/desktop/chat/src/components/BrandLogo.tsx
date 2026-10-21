'use client';

import React from 'react';

/*
 * The КиноКод mark (a placeholder): a film strip with sprocket holes and a code chevron, together a К, and a cursor,
 * in the surrounding text color (currentColor). The holes are cut out (a real gap, showing what is behind).
 */
const VIEWBOX = '8 6 92 90';
const CHEVRON = 'M84 15L51 50L84 85';
const HOLES = [20, 46, 72];

export function BrandLogo({ size = 18, className }: { size?: number; className?: string }) {
  const gap = `openfilm-gap-${React.useId().replace(/:/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      fill="currentColor"
      className={`block shrink-0 ${className ?? ''}`.trim()}
      role="img"
      aria-label="КиноКод"
    >
      <mask id={gap} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#fff" />
        {HOLES.map((y) => <rect key={y} x="21.5" y={y} width="6" height="8" rx="1.5" fill="#000" />)}
      </mask>
      <rect x="16" y="12" width="17" height="76" rx="4.5" mask={`url(#${gap})`} />
      <path d={CHEVRON} fill="none" stroke="currentColor" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="80" y="43" width="12" height="14" rx="2.5" />
    </svg>
  );
}
