import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MessageBubble } from '@/client/components/chat/MessageBubble'
import { TooltipProvider } from '@/client/components/ui/tooltip'
import '@/client/lib/i18n'
import '@/client/styles/globals.css'

const content = 'Alpha **selected words** omega.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.'
Object.assign(window, { copyTestContent: content, copyTestQuotes: [] as string[] })
createRoot(document.getElementById('root')!).render(
  <BrowserRouter><TooltipProvider>
    <main style={{ maxWidth: 800, margin: '80px auto' }}>
      <div data-testid="message"><MessageBubble role="assistant" sourceType="agent" content={content} senderName="Test agent" messageId="copy-test" onQuoteReply={(text) => (window as any).copyTestQuotes.push(text)} /></div>
      <p data-testid="outside">Unrelated selected text</p>
    </main>
  </TooltipProvider></BrowserRouter>,
)
