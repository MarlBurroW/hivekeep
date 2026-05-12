import { memo, useEffect, useRef } from 'react'
import { cn } from '@/client/lib/utils'

interface LogStreamProps {
  lines: string[]
  autoscroll?: boolean
  maxHeight?: number
}

export const LogStream = memo(function LogStream({ lines, autoscroll = true, maxHeight = 240 }: LogStreamProps) {
  const ref = useRef<HTMLDivElement>(null)
  const safeLines = Array.isArray(lines) ? lines : []

  useEffect(() => {
    if (!autoscroll || !ref.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [safeLines.length, autoscroll])

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-md border border-border bg-muted/30 px-3 py-2',
        'overflow-y-auto font-mono text-[11px] leading-relaxed text-muted-foreground',
      )}
      style={{ maxHeight }}
    >
      {safeLines.length === 0 ? (
        <span className="italic opacity-60">No output yet.</span>
      ) : (
        safeLines.map((line, idx) => (
          <div key={idx} className="whitespace-pre-wrap break-words">
            {line}
          </div>
        ))
      )}
    </div>
  )
})
