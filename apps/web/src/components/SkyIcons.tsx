import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="sky-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function PlanetIcon() {
  return <Icon><circle cx="12" cy="12" r="5.5" /><path d="M3 16c2.6 2.8 8.2 3.2 12.8 1.3 3.5-1.5 5.6-3.8 5.2-5.7" /><path d="M3 16c-.5-2.5 2.7-5.5 7-7.3" /></Icon>;
}

export function PanIcon() {
  return <Icon><path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5" /></Icon>;
}

export function RegionIcon() {
  return <Icon><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" /><rect x="7" y="7" width="10" height="10" rx="1" strokeDasharray="2 2" /></Icon>;
}

export function ZoomOutIcon() {
  return <Icon><path d="M5 12h14" /></Icon>;
}

export function ZoomInIcon() {
  return <Icon><path d="M5 12h14M12 5v14" /></Icon>;
}

export function AllSkyIcon() {
  return <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-2.8 2.5-4.2 5.5-4.2 9s1.4 6.5 4.2 9c2.8-2.5 4.2-5.5 4.2-9S14.8 5.5 12 3Z" /></Icon>;
}
