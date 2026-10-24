/** The product mark: a front-wheeled walker frame, drawn as one line. Decorative next to the wordmark. */
export function WalkerMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <path
        d="M8 21V9.5a2.5 2.5 0 0 1 2.5-2.5h7A2.5 2.5 0 0 1 20 9.5V21M8 15h12"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="21.5" r="1.6" fill="#fff" />
      <circle cx="20" cy="21.5" r="1.6" fill="#fff" />
    </svg>
  );
}
