export function OctoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <rect width="24" height="24" rx="7" fill="var(--octo-accent)" />
      <circle cx="12" cy="10" r="4.1" fill="none" stroke="var(--octo-accent-fg)" strokeWidth="2.2" />
      <circle cx="6.6" cy="17.4" r="1.45" fill="var(--octo-accent-fg)" />
      <circle cx="12" cy="19.1" r="1.45" fill="var(--octo-accent-fg)" />
      <circle cx="17.4" cy="17.4" r="1.45" fill="var(--octo-accent-fg)" />
    </svg>
  );
}
