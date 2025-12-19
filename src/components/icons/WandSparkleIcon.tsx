import { cn } from '@/lib/utils'

type Props = {
  className?: string
  active?: boolean
}

/**
 * Wand icon with 3 sparkles that pulse when active.
 * Uses the same SVG paths as lucide's Wand2/WandSparkles.
 */
export function WandSparkleIcon({ className, active = false }: Props) {
  const sparkleClass = active ? 'cta-sparkle-active' : ''

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('', className)}
    >
      {/* Wand body */}
      <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
      <path d="m14 7 3 3" />

      {/* Sparkle 1: top (around x=10, y=2-3) */}
      <g className={sparkleClass} style={active ? { animationDelay: '0ms' } : undefined} strokeWidth="1.5">
        <path d="M10 2v2" vectorEffect="non-scaling-stroke" />
        <path d="M11 3H9" vectorEffect="non-scaling-stroke" />
      </g>

      {/* Sparkle 2: left (around x=5, y=8) */}
      <g className={sparkleClass} style={active ? { animationDelay: '500ms' } : undefined} strokeWidth="1.5">
        <path d="M5 6v4" vectorEffect="non-scaling-stroke" />
        <path d="M7 8H3" vectorEffect="non-scaling-stroke" />
      </g>

      {/* Sparkle 3: right (around x=19, y=16) */}
      <g className={sparkleClass} style={active ? { animationDelay: '1000ms' } : undefined} strokeWidth="1.5">
        <path d="M19 14v4" vectorEffect="non-scaling-stroke" />
        <path d="M21 16h-4" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  )
}
