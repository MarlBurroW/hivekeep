import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { Alert, AlertDescription } from '@/client/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { AlertCircle, Camera, Loader2 } from 'lucide-react'
import { useAuth } from '@/client/hooks/useAuth'
import { api, getErrorMessage } from '@/client/lib/api'
import { getUserInitials } from '@/client/lib/utils'

interface StepIdentityProps {
  onComplete: () => void
}

type FieldName = 'firstName' | 'lastName' | 'email' | 'pseudonym' | 'password' | 'passwordConfirm'

/**
 * Translate the Better Auth body field name into the local form
 * field name. Better Auth's sign-up body uses { name, email, password };
 * we split `name` into firstName/lastName on submit, so any error
 * tagged with `name` is shown on the firstName input.
 */
function mapAuthFieldToFormField(authField: string): FieldName | null {
  if (authField === 'email') return 'email'
  if (authField === 'password') return 'password'
  if (authField === 'name') return 'firstName'
  return null
}

/**
 * Parse an error thrown by Better Auth (or Hivekeep's wrapped routes)
 * into a per-field map. Better Auth's HTTP body is only
 * `{ message, code }` — the `issues` array exists on the server-side
 * APIError but is dropped during serialization. So we recover the
 * field name from the `[body.fieldName] …` prefix that better-call's
 * validator injects into the message, falling back to a code → field
 * lookup for non-validation errors (PASSWORD_TOO_SHORT, etc.).
 *
 * Multi-field validation errors are joined with `; ` in the message,
 * so we split on that delimiter and parse each segment.
 *
 * Returns { fields, fallback } — fallback is set when no field-level
 * mapping was possible (the destructive Alert still shows then).
 */
function extractFieldErrors(err: unknown): {
  fields: Partial<Record<FieldName, string>>
  fallback: string | null
} {
  if (err === null || typeof err !== 'object') {
    return { fields: {}, fallback: null }
  }
  const o = err as {
    message?: unknown
    code?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  const rawMessage = typeof o.message === 'string'
    ? o.message
    : typeof o.error?.message === 'string'
      ? o.error.message
      : ''
  const code = typeof o.code === 'string'
    ? o.code
    : typeof o.error?.code === 'string'
      ? o.error.code
      : ''
  const fields: Partial<Record<FieldName, string>> = {}

  // 1. Parse the `[body.field] message; [body.other] message` shape
  //    that better-call emits for schema validation failures.
  if (rawMessage) {
    const segments = rawMessage.split(/;\s+(?=\[)/)
    for (const segment of segments) {
      const match = segment.match(/^\[body\.([^\]]+)\]\s*(.*)$/)
      if (!match) continue
      const authField = match[1]!
      const cleanMessage = match[2]!.trim() || segment
      const formField = mapAuthFieldToFormField(authField)
      if (formField && !fields[formField]) fields[formField] = cleanMessage
    }
  }

  // 2. Coded errors (no bracket prefix) — map known Better Auth codes
  //    to the field they refer to.
  if (Object.keys(fields).length === 0 && rawMessage) {
    switch (code) {
      case 'PASSWORD_TOO_SHORT':
      case 'PASSWORD_TOO_LONG':
        fields.password = rawMessage
        break
      case 'INVALID_EMAIL':
      case 'USER_ALREADY_EXISTS':
      case 'USER_NOT_FOUND':
        fields.email = rawMessage
        break
      case 'INVALID_EMAIL_OR_PASSWORD':
      case 'INVALID_PASSWORD':
        // Better Auth's login route uses a generic code to avoid
        // leaking which side is wrong. Highlight both inputs so the
        // user can fix either.
        fields.email = rawMessage
        fields.password = rawMessage
        break
    }
  }

  const fallback = Object.keys(fields).length === 0 ? rawMessage || null : null
  return { fields, fallback }
}

export function StepIdentity({ onComplete }: StepIdentityProps) {
  const { t } = useTranslation()
  const { register, login } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [pseudonym, setPseudonym] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [isLoading, setIsLoading] = useState(false)

  const clearFieldError = (field: FieldName) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const applyError = (err: unknown) => {
    const { fields, fallback } = extractFieldErrors(err)
    setFieldErrors(fields)
    setError(fallback ?? (Object.keys(fields).length === 0 ? getErrorMessage(err) || t('common.error') : ''))
  }

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
    setFieldErrors({})

    if (password !== passwordConfirm) {
      setFieldErrors({ passwordConfirm: t('onboarding.identity.passwordMismatch') })
      return
    }

    setIsLoading(true)

    try {
      // 1. Register via Better Auth (or login if already registered)
      try {
        await register({
          name: `${firstName} ${lastName}`.trim(),
          email,
          password,
        })
      } catch (regErr: unknown) {
        // If registration fails because email already exists, try logging in instead.
        // This handles the case where registration succeeded but profile creation
        // failed on a previous attempt, leaving the user stuck.
        const regMsg = getErrorMessage(regErr) || ''
        if (regMsg.toLowerCase().includes('already') || regMsg.toLowerCase().includes('exists')) {
          await login(email, password)
        } else {
          throw regErr
        }
      }

      // 2. Create user profile (will 409 if it already exists, which is fine)
      try {
        await api.post('/onboarding/profile', {
          firstName,
          lastName,
          pseudonym,
          language: 'en',
        })
      } catch (profileErr: unknown) {
        const profileMsg = getErrorMessage(profileErr) || ''
        // If profile already exists (409), skip gracefully
        if (!profileMsg.includes('PROFILE_EXISTS') && !profileMsg.includes('already exists')) {
          throw profileErr
        }
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

      onComplete()
    } catch (err: unknown) {
      applyError(err)
    } finally {
      setIsLoading(false)
    }
  }

  const initials = getUserInitials({ pseudonym, firstName, lastName })

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground">
          {t('onboarding.identity.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('onboarding.identity.subtitle')}
        </p>
      </div>

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
          <Label htmlFor="firstName">{t('onboarding.identity.firstName')}</Label>
          <Input
            id="firstName"
            value={firstName}
            onChange={(e) => { setFirstName(e.target.value); clearFieldError('firstName') }}
            required
            aria-invalid={!!fieldErrors.firstName}
            aria-describedby={fieldErrors.firstName ? 'firstName-error' : undefined}
          />
          {fieldErrors.firstName && (
            <p id="firstName-error" className="text-xs text-destructive">{fieldErrors.firstName}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">
            {t('onboarding.identity.lastName')}
            <span className="ml-1 font-normal text-muted-foreground">({t('common.optional')})</span>
          </Label>
          <Input
            id="lastName"
            value={lastName}
            onChange={(e) => { setLastName(e.target.value); clearFieldError('lastName') }}
            aria-invalid={!!fieldErrors.lastName}
            aria-describedby={fieldErrors.lastName ? 'lastName-error' : undefined}
          />
          {fieldErrors.lastName && (
            <p id="lastName-error" className="text-xs text-destructive">{fieldErrors.lastName}</p>
          )}
        </div>
      </div>

      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="email">{t('onboarding.identity.email')}</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); clearFieldError('email') }}
          required
          autoComplete="email"
          aria-invalid={!!fieldErrors.email}
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
        />
        {fieldErrors.email && (
          <p id="email-error" className="text-xs text-destructive">{fieldErrors.email}</p>
        )}
      </div>

      {/* Pseudonym */}
      <div className="space-y-2">
        <Label htmlFor="pseudonym">{t('onboarding.identity.pseudonym')}</Label>
        <Input
          id="pseudonym"
          value={pseudonym}
          onChange={(e) => { setPseudonym(e.target.value); clearFieldError('pseudonym') }}
          required
          aria-invalid={!!fieldErrors.pseudonym}
          aria-describedby={fieldErrors.pseudonym ? 'pseudonym-error' : undefined}
        />
        {fieldErrors.pseudonym ? (
          <p id="pseudonym-error" className="text-xs text-destructive">{fieldErrors.pseudonym}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('onboarding.identity.pseudonymHint')}
          </p>
        )}
      </div>

      {/* Password */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="password">{t('onboarding.identity.password')}</Label>
          <PasswordInput
            id="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); clearFieldError('password') }}
            required
            autoComplete="new-password"
            aria-invalid={!!fieldErrors.password}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
          />
          {fieldErrors.password && (
            <p id="password-error" className="text-xs text-destructive">{fieldErrors.password}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="passwordConfirm">{t('onboarding.identity.passwordConfirm')}</Label>
          <PasswordInput
            id="passwordConfirm"
            value={passwordConfirm}
            onChange={(e) => { setPasswordConfirm(e.target.value); clearFieldError('passwordConfirm') }}
            required
            autoComplete="new-password"
            aria-invalid={!!fieldErrors.passwordConfirm}
            aria-describedby={fieldErrors.passwordConfirm ? 'passwordConfirm-error' : undefined}
          />
          {fieldErrors.passwordConfirm && (
            <p id="passwordConfirm-error" className="text-xs text-destructive">{fieldErrors.passwordConfirm}</p>
          )}
        </div>
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
            {t('common.loading')}
          </>
        ) : (
          t('common.next')
        )}
      </Button>
    </form>
  )
}
