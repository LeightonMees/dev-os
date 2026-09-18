/** Minimal 16px stroke icons. Fixed set; no icon font. */
const PATHS: Record<string, string> = {
  overview: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  work: "M2 2h3v12H2zM6.5 2h3v8h-3zM11 2h3v5h-3z",
  workers: "M4 4h8v8H4zM6 6h4v4H6zM8 1v3M8 12v3M1 8h3M12 8h3",
  terminal: "M2 3h12v10H2zM4.5 6l2.5 2-2.5 2M8 10h3.5",
  git: "M5 3v10M5 3a1.5 1.5 0 100 .01M5 13a1.5 1.5 0 100 .01M11 4a1.5 1.5 0 100 .01M11 5.5c0 3-6 2-6 5.5",
  artifacts: "M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6",
  editor: "M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6zM9 2v4h4M5.5 9.5L7 11l-1.5 1.5M8.5 12.5h2",
  resources: "M6 2v3M10 2v3M4 5h8v3a4 4 0 01-8 0zM8 12v2",
  settings: "M2 4h12M2 8h12M2 12h12M5 2.5v3M11 6.5v3M7 10.5v3",
  search: "M7 2a5 5 0 100 10 5 5 0 000-10zM10.5 10.5L14 14",
  // Two boxes wired to a third: a flow's shape at a glance.
  flows: "M2 3h4v3H2zM2 10h4v3H2zM10 6.5h4v3h-4zM6 4.5h2.5v3.5H10M6 11.5h2.5V8H10",
  plus: "M8 3v10M3 8h10",
  play: "M4 2l9 6-9 6z",
  stop: "M3 3h10v10H3z",
  check: "M2 8l4 4 8-8",
  x: "M3 3l10 10M13 3L3 13",
  chevron: "M5 3l5 5-5 5",
  panel: "M2 3h12v10H2zM2 9h12",
  side: "M2 3h12v10H2zM6 3v10",
  refresh: "M13 8a5 5 0 11-1.5-3.5M13 2v3h-3",
  chat: "M2 3h12v8H6l-3 3v-3H2zM5 6h6M5 8.5h4",
  send: "M2 8l12-6-4 12-2-5z",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  const d = PATHS[name] ?? PATHS.overview;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
