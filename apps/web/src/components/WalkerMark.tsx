/**
 * Steady's mark: an "S" drawn as one pen line that ends in a signal-green nib, the same pen that draws
 * the walker. Ink tile, paper line, green nib; fixed colours, so it reads the same on light and dark
 * grounds. `app/icon.svg` is the same drawing, used as the favicon. Decorative next to the wordmark.
 */
export function WalkerMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#14201c" />
      <path
        d="M21.6 10.4c-1.1-1.7-3-2.8-5.5-2.8-3.3 0-5.7 1.8-5.7 4.5 0 5.7 11.4 3.4 11.4 9.2 0 2.8-2.5 4.6-5.9 4.6-2.2 0-4.1-.8-5.4-2.3"
        fill="none"
        stroke="#f1f4f2"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="10.5" cy="23.6" r="2.5" fill="#5ccb93" />
    </svg>
  );
}
