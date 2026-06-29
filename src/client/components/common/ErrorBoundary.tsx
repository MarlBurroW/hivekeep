import { Component, type ReactNode } from 'react'
import i18n from '@/client/lib/i18n'
import { GezyLogo } from '@/client/components/common/GezyLogo'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  override render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="surface-base flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center animate-fade-in">
          <GezyLogo size={64} title={null} className="mx-auto" />
          <h1 className="text-4xl font-extrabold text-foreground">Gezy</h1>
          <p className="text-muted-foreground">{i18n.t('errorBoundary.message')}</p>
          {this.state.error && (
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted p-3 text-left text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {i18n.t('errorBoundary.reload')}
          </button>
        </div>
      </div>
    )
  }
}
