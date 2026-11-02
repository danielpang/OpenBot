import type { ReactNode, SVGProps } from 'react';
import type { ProfileKind } from '../ipc.js';

// The app pages' glyphs, inline like @openbots/ui's (no icon library). The
// three connection kinds draw exactly as the web app's connection indicator
// (apps/web/src/app/connection-indicator.tsx); the rest are lucide's shapes.

type IconProps = SVGProps<SVGSVGElement>;

function icon(paths: ReactNode) {
  return function Icon(props: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const CloudIcon = icon(
  <path d="M17.5 19H8a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20.5 11 4 4 0 0 1 17.5 19Z" />,
);
export const ServerIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </>,
);
export const LaptopIcon = icon(
  <>
    <rect x="4" y="5" width="16" height="11" rx="1.5" />
    <path d="M2 19h20" />
  </>,
);

export function KindIcon({ kind, ...props }: { kind: ProfileKind } & IconProps) {
  const Icon = kind === 'cloud' ? CloudIcon : kind === 'remote' ? ServerIcon : LaptopIcon;
  return <Icon data-kind={kind} {...props} />;
}

export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);
export const AlertCircleIcon = icon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </>,
);
export const AlertTriangleIcon = icon(
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4M12 17h.01" />
  </>,
);
export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </>,
);
export const ExternalLinkIcon = icon(
  <>
    <path d="M15 3h6v6M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </>,
);
export const ChevronRightIcon = icon(<path d="m9 18 6-6-6-6" />);
export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />);
export const ArrowRightIcon = icon(<path d="M5 12h14M12 5l7 7-7 7" />);
export const RefreshIcon = icon(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
);
export const TerminalIcon = icon(<path d="m4 17 6-6-6-6M12 19h8" />);
export const DownloadIcon = icon(
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
);
export const PlayIcon = icon(<path d="M6 3l14 9-14 9V3Z" />);
export const SunIcon = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </>,
);
export const MoonIcon = icon(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />);
export const UserIcon = icon(
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
);
export const ReturnIcon = icon(<path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" />);
