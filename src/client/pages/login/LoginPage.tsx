import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { GezyLogo } from '@/client/components/common/GezyLogo'
import { Alert, AlertDescription } from '@/client/components/ui/alert'
import { AlertCircle, Loader2 } from 'lucide-react'

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<void>
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      await onLogin(email, password)
    } catch {
      setError(t('login.error'))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="surface-base flex min-h-screen items-center justify-center px-4">
      {/* Decorative orbs */}
      <div className="theme-orb theme-orb-1 fixed left-1/4 top-1/4 h-64 w-64 aurora-drift" />
      <div className="theme-orb theme-orb-2 fixed right-1/4 bottom-1/4 h-48 w-48 aurora-drift delay-3" />
      <div className="theme-orb theme-orb-3 fixed left-1/2 top-2/3 h-56 w-56 aurora-drift delay-5" />

      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        {/* Glass card */}
        <div className="glass-strong rounded-2xl p-8 shadow-lg">
          {/* Header */}
          <div className="mb-8 text-center">
            <GezyLogo size={64} title={null} className="mx-auto mb-3" />
            <h1 className="text-3xl font-extrabold text-foreground">Gezy</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('login.subtitle')}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <Alert variant="destructive" className="animate-scale-in">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2 animate-fade-in-up delay-1">
              <Label htmlFor="email">{t('login.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder={t('login.emailPlaceholder')}
                autoComplete="email"
              />
            </div>

            <div className="space-y-2 animate-fade-in-up delay-2">
              <Label htmlFor="password">{t('login.password')}</Label>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <div className="text-right animate-fade-in-up delay-2">
              <p className="text-xs text-muted-foreground">
                {t('login.forgotPassword')}
              </p>
            </div>

            <div className="animate-fade-in-up delay-3 pt-1">
              <Button
                type="submit"
                disabled={isLoading}
                className="btn-shine w-full"
                size="lg"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('login.submitting')}
                  </>
                ) : (
                  t('login.submit')
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
