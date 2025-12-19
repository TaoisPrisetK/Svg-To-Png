import { Image as ImageIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

type Props = {
  className?: string
  title?: string
  open?: boolean
}

function SolidMoonCrescent({ className }: { className?: string }) {
  // Simple filled crescent (SVG path), uses currentColor.
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 1 0 9.79 9.79z" />
    </svg>
  )
}

/**
 * "Image" icon where the small circle turns into a crescent moon on hover.
 * Implementation: overlay a small Moon icon at the circle position,
 * and fade the original <circle> out on `.group:hover`.
 */
export function HoverImageMoonIcon({ className, title, open }: Props) {
  const isOpen = !!open
  return (
    <span className={cn('relative inline-block shrink-0', className)} aria-hidden="true" title={title}>
      <ImageIcon
        className={cn(
          'h-full w-full',
          'transition-transform duration-200 ease-out',
          // replace the inner circle
          '[&>circle]:transition-opacity [&>circle]:duration-120 [&>circle]:ease-out',
          isOpen ? '[&>circle]:opacity-0' : '[&>circle]:opacity-100 group-hover:[&>circle]:opacity-0'
        )}
      />

      {/* Moon overlay positioned where ImageIcon's circle sits */}
      <SolidMoonCrescent
        className={cn(
          'pointer-events-none absolute',
          // tuned for lucide Image icon (24x24): circle is near top-left
          'left-[22%] top-[23%] h-[34%] w-[34%]',
          isOpen ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-[0.7] rotate-[-18deg]',
          'transition-[opacity,transform] duration-200 ease-out',
          'group-hover:opacity-100 group-hover:scale-100 group-hover:rotate-0'
        )}
      />
    </span>
  )
}


