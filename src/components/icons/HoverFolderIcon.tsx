import { Folder, FolderOpen } from 'lucide-react'

import { cn } from '@/lib/utils'

type Props = {
  className?: string
  title?: string
  open?: boolean
}

/**
 * Folder icon that "opens" on hover.
 * Uses the parent `.group` hover state (our Button base class includes `group`).
 */
export function HoverFolderIcon({ className, title, open }: Props) {
  const isOpen = !!open
  return (
    <span
      className={cn(
        'relative inline-block shrink-0 align-[-0.125em]',
        // ensure the wrapper has a stable box so swapping icons never shifts layout
        className
      )}
      aria-hidden="true"
      title={title}
    >
      {/* Closed state */}
      <Folder
        className={cn(
          'absolute inset-0 h-full w-full pointer-events-none',
          isOpen ? 'opacity-0 -translate-y-0.5 rotate-[-6deg] scale-[0.98]' : 'opacity-100 translate-y-0 rotate-0 scale-100',
          'transition-[opacity,transform] duration-200 ease-out',
          'group-hover:opacity-0 group-hover:-translate-y-0.5 group-hover:rotate-[-6deg] group-hover:scale-[0.98]'
        )}
      />

      {/* Open state */}
      <FolderOpen
        className={cn(
          'absolute inset-0 h-full w-full pointer-events-none',
          isOpen ? 'opacity-100 translate-y-0 rotate-0 scale-[1.04]' : 'opacity-0 translate-y-0.5 rotate-[6deg] scale-[0.98]',
          'transition-[opacity,transform] duration-220 ease-out',
          'group-hover:opacity-100 group-hover:translate-y-0 group-hover:rotate-0 group-hover:scale-[1.04]'
        )}
      />
    </span>
  )
}


