import { memo } from 'react'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'

interface MarkdownProps {
  content: string
}

export const Markdown = memo(function Markdown({ content }: MarkdownProps) {
  return (
    <div className="prose-card text-sm">
      <MarkdownContent content={content} />
    </div>
  )
})
