import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Button } from '@/client/components/ui/button'
import { GezyLogo } from '@/client/components/common/GezyLogo'
import { Label } from '@/client/components/ui/label'
import { Alert, AlertDescription } from '@/client/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { AlertCircle, Camera, Loader2, ArrowLeft } from 'lucide-react'
import { LanguageSelector, AgentLanguageSelector } from '@/client/components/common/LanguageSelector'
import { getErrorMessage } from '@/client/lib/api'
import { getUserInitials } from '@/client/lib/utils'
import { validateProfileFields } from '@/shared/profile-validation'
import { translateProfileErrorCode } from '@/client/lib/profile-validation-i18n'

export function InvitePage() {
  const { t, i18n } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [validating, setValidating] = useState(true)
  const [valid, setValid] = useState(false)
  const [inviteLabel, setInviteLabel] = useState<string | null>(null)

  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [pseudonym, setPseudonym] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  // Defaults to the auto-detected browser language (see lib/i18n.ts)
  const [language, setLanguage] = useState(i18n.language || 'en')
  // null = Agents follow the UI language
  const [agentLanguage, setAgentLanguage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setValid(false)
      setValidating(false)
      return
    }

    fetch(`/api/invitations/${token}/validate`)
      .then((res) => res.json())
      .then((data) => {
        setValid(data.valid)
        if (data.label) setInviteLabel(data.label)
      })
      .catch(() => setValid(false))
      .finally(() => setValidating(false))
  }, [token])

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onload = () => setAvatarPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const { issues } = validateProfileFields(
      { firstName, lastName, pseudonym },
      { require: ['firstName', 'pseudonym'] },
    )
    if (issues.length > 0) {
      setError(translateProfileErrorCode(t, issues[0]!.code))
      return
    }

    if (password !== passwordConfirm) {
      setError(t('invite.passwordMismatch'))
      return
    }

    // Re-validate token before submitting
    try {
      const validateRes = await fetch(`/api/invitations/${token}/validate`)
      const validateData = await validateRes.json()
      if (!validateData.valid) {
        setError(t('invite.invalidToken'))
        return
      }
    } catch {
      setError(t('invite.error'))
      return
    }

    setIsLoading(true)

    try {
      // 1. Register via Better Auth
      const signupRes = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: `${firstName} ${lastName}`,
          email,
          password,
        }),
      })

      if (!signupRes.ok) {
        const data = await signupRes.json().catch(() => ({}))
        throw new Error(data?.message || data?.error?.message || 'Registration failed')
      }

      // 2. Create user profile with invitation token
      const profileRes = await fetch('/api/onboarding/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          firstName,
          lastName,
          pseudonym,
          language,
          agentLanguage,
          invitationToken: token,
        }),
      })

      if (!profileRes.ok) {
        const data = await profileRes.json().catch(() => ({}))
        throw new Error(data?.error?.message || 'Profile creation failed')
      }

      // 3. Upload avatar if provided
      if (avatarFile) {
        const formData = new FormData()
        formData.append('file', avatarFile)
        await fetch('/api/me/avatar', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })
      }

      setSuccess(true)
      // Redirect to app after short delay
      setTimeout(() => navigate('/'), 1500)
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('invite.error'))
    } finally {
      setIsLoading(false)
    }
  }

  const initials = getUserInitials({ pseudonym, firstName, lastName })

  // Loading state
  if (validating) {
    return (
      <div className="surface-base flex min-h-screen items-center justify-center">
        <div className="text-center animate-fade-in">
          <GezyLogo size={56} title={null} className="mx-auto mb-3" />
          <h1 className="text-4xl font-extrabold text-foreground">Gezy</h1>
          <p className="mt-3 text-muted-foreground">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  // Invalid token
  if (!valid) {
    return (
      <div className="surface-base flex min-h-screen items-center justify-center px-4">
        <div className="theme-orb theme-orb-1 fixed left-1/4 top-1/4 h-64 w-64 aurora-drift" />
        <div className="theme-orb theme-orb-2 fixed right-1/4 bottom-1/4 h-48 w-48 aurora-drift delay-3" />

        <div className="relative z-10 w-full max-w-md animate-fade-in-up">
          <div className="glass-strong rounded-2xl p-8 shadow-lg text-center space-y-4">
            <GezyLogo size={56} title={null} className="mx-auto" />
            <h1 className="text-3xl font-extrabold text-foreground">Gezy</h1>
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{t('invite.invalidToken')}</AlertDescription>
            </Alert>
            <Button variant="outline" onClick={() => navigate('/')}>
              <ArrowLeft className="size-4" />
              {t('invite.backToLogin')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Success state
  if (success) {
    return (
      <div className="surface-base flex min-h-screen items-center justify-center">
        <div className="text-center animate-fade-in space-y-2">
          <GezyLogo size={56} title={null} className="mx-auto" />
          <h1 className="text-4xl font-extrabold text-foreground">Gezy</h1>
          <p className="text-muted-foreground">{t('invite.success')}</p>
        </div>
      </div>
    )
  }

  // Registration form
  return (
    <div className="surface-base flex min-h-screen items-center justify-center px-4 py-8">
      <div className="theme-orb theme-orb-1 fixed left-1/4 top-1/4 h-64 w-64 aurora-drift" />
      <div className="theme-orb theme-orb-2 fixed right-1/4 bottom-1/4 h-48 w-48 aurora-drift delay-3" />
      <div className="theme-orb theme-orb-3 fixed left-1/2 top-2/3 h-56 w-56 aurora-drift delay-5" />

      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        <div className="glass-strong rounded-2xl p-8 shadow-lg">
          {/* Header */}
          <div className="mb-6 text-center">
            <GezyLogo size={64} title={null} className="mx-auto mb-3" />
            <h1 className="text-3xl font-extrabold text-foreground">Gezy</h1>
            <h2 className="mt-2 text-lg font-semibold text-foreground">
              {t('invite.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {inviteLabel
                ? `${t('invite.subtitle')} — ${inviteLabel}`
                : t('invite.subtitle')
              }
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <Alert variant="destructive" className="animate-scale-in">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Avatar upload */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group relative"
              >
                <Avatar className="size-20 ring-2 ring-border transition-all group-hover:ring-primary">
                  {avatarPreview ? (
                    <AvatarImage src={avatarPreview} alt="Avatar" />
                  ) : (
                    <AvatarFallback className="text-lg">
                      {initials || <Camera className="size-6 text-muted-foreground" />}
                    </AvatarFallback>
                  )}
                </Avatar>
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="size-5 text-white" />
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                className="hidden"
              />
            </div>

            {/* Name fields */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">{t('invite.firstName')}</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">{t('invite.lastName')}</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Pseudonym */}
            <div className="space-y-2">
              <Label htmlFor="pseudonym">{t('invite.pseudonym')}</Label>
              <Input
                id="pseudonym"
                value={pseudonym}
                onChange={(e) => setPseudonym(e.target.value)}
                required
              />
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email">{t('invite.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            {/* Password */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="password">{t('invite.password')}</Label>
                <PasswordInput
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="passwordConfirm">{t('invite.confirmPassword')}</Label>
                <PasswordInput
                  id="passwordConfirm"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
            </div>

            {/* Interface language */}
            <div className="space-y-2">
              <Label>{t('invite.language')}</Label>
              <LanguageSelector value={language} onValueChange={setLanguage} />
            </div>

            {/* Agent communication language */}
            <div className="space-y-2">
              <Label>{t('invite.agentLanguage')}</Label>
              <AgentLanguageSelector value={agentLanguage} onValueChange={setAgentLanguage} />
              <p className="text-xs text-muted-foreground">{t('invite.agentLanguageHint')}</p>
            </div>

            {/* Submit */}
            <Button
              type="submit"
              disabled={isLoading}
              className="btn-shine w-full"
              size="lg"
            >
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('invite.creating')}
                </>
              ) : (
                t('invite.submit')
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
