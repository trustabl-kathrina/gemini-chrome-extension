/** The four-point spark with the Gemini gradient. One <defs> per mark keeps it self-contained. */
export function Sparkle({ size = 18, className = '' }: { size?: number; className?: string }) {
  const id = `dl-g-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={id} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285f4" />
          <stop offset="0.45" stopColor="#9b72cb" />
          <stop offset="0.75" stopColor="#d96570" />
          <stop offset="1" stopColor="#f49c46" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12 2c.4 5.6 4.4 9.6 10 10-5.6.4-9.6 4.4-10 10-.4-5.6-4.4-9.6-10-10 5.6-.4 9.6-4.4 10-10z"
      />
    </svg>
  );
}
