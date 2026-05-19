import { Link } from 'react-router'
import { Github, ExternalLink, Heart } from 'lucide-react'

const productLinks = [
  { label: 'Features', to: '/features' },
  { label: 'Architecture', to: '/architecture' },
  { label: 'Changelog', to: '/changelog' },
  { label: 'FAQ', to: '/faq' },
]

const resourceLinks = [
  { label: 'Documentation', href: '/kinbot/docs/' },
  { label: 'GitHub', href: 'https://github.com/MarlBurroW/kinbot' },
  { label: 'Releases', href: 'https://github.com/MarlBurroW/kinbot/releases' },
  { label: 'Issues', href: 'https://github.com/MarlBurroW/kinbot/issues' },
  { label: 'Discussions', href: 'https://github.com/MarlBurroW/kinbot/discussions' },
  { label: 'Contributing', href: 'https://github.com/MarlBurroW/kinbot/blob/main/CONTRIBUTING.md' },
  { label: 'Troubleshooting', href: 'https://github.com/MarlBurroW/kinbot/blob/main/TROUBLESHOOTING.md' },
  { label: 'Security Policy', href: 'https://github.com/MarlBurroW/kinbot/blob/main/SECURITY.md' },
  { label: 'E2E Report', href: 'https://marlburrow.github.io/kinbot/e2e-report/' },
]

const communityLinks = [
  { label: 'Discussions', href: 'https://github.com/MarlBurroW/kinbot/discussions' },
  { label: 'Star on GitHub', href: 'https://github.com/MarlBurroW/kinbot/stargazers' },
  { label: 'Report a Bug', href: 'https://github.com/MarlBurroW/kinbot/issues/new?template=bug_report.yml' },
  { label: 'Request a Feature', href: 'https://github.com/MarlBurroW/kinbot/issues/new?template=feature_request.yml' },
  { label: 'Request a Provider', href: 'https://github.com/MarlBurroW/kinbot/issues/new?template=provider_request.yml' },
  { label: 'Request a Channel', href: 'https://github.com/MarlBurroW/kinbot/issues/new?template=channel_request.yml' },
]

const techStack = [
  { name: 'Bun', url: 'https://bun.sh' },
  { name: 'Hono', url: 'https://hono.dev' },
  { name: 'React', url: 'https://react.dev' },
  { name: 'TypeScript', url: 'https://www.typescriptlang.org' },
  { name: 'SQLite', url: 'https://sqlite.org' },
  { name: 'Drizzle', url: 'https://orm.drizzle.team' },
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com' },
  { name: 'Better Auth', url: 'https://www.better-auth.com' },
]

function FooterColumnHeading({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-xs font-semibold uppercase tracking-wider mb-4"
      style={{ color: 'var(--color-muted-foreground)' }}
    >
      {children}
    </p>
  )
}

function FooterInternalColumn({ title, links }: { title: string; links: { label: string; to: string }[] }) {
  return (
    <div>
      <FooterColumnHeading>{title}</FooterColumnHeading>
      <ul className="space-y-2.5">
        {links.map(({ label, to }) => (
          <li key={label}>
            <Link
              to={to}
              className="inline-flex items-center gap-1 text-sm transition-colors duration-200"
              style={{ color: 'var(--color-muted-foreground)' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-muted-foreground)' }}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FooterExternalColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <FooterColumnHeading>{title}</FooterColumnHeading>
      <ul className="space-y-2.5">
        {links.map(({ label, href }) => {
          const isExternal = href.startsWith('http')
          return (
            <li key={label}>
              <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                className="inline-flex items-center gap-1 text-sm transition-colors duration-200"
                style={{ color: 'var(--color-muted-foreground)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-primary)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-muted-foreground)' }}
              >
                {label}
                {isExternal && <ExternalLink size={11} className="opacity-50" />}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer
      className="border-t px-6 pt-16 pb-8"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Main grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-10 mb-12">
          {/* Brand column */}
          <div className="col-span-2 sm:col-span-1">
            <a href="#" className="inline-flex items-center gap-2.5 mb-3">
              <img src="/kinbot/kinbot.svg" alt="KinBot" width={28} height={28} className="rounded-lg" />
              <span className="text-lg font-extrabold gradient-text">KinBot</span>
            </a>
            <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--color-muted-foreground)' }}>
              Self-hosted AI agents with persistent memory. Your data, your server, your rules.
            </p>
            <a
              href="https://github.com/MarlBurroW/kinbot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm font-medium transition-all duration-200 hover:scale-105"
              style={{ color: 'var(--color-muted-foreground)' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-muted-foreground)' }}
            >
              <Github size={16} />
              Star on GitHub
            </a>
          </div>

          <FooterInternalColumn title="Product" links={productLinks} />
          <FooterExternalColumn title="Resources" links={resourceLinks} />
          <FooterExternalColumn title="Community" links={communityLinks} />
        </div>

        {/* Tech stack */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
          <span className="text-xs font-medium mr-1" style={{ color: 'var(--color-muted-foreground)', opacity: 0.6 }}>
            Built with
          </span>
          {techStack.map(({ name, url }) => (
            <a
              key={name}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:scale-105"
              style={{
                background: 'color-mix(in oklch, var(--color-muted-foreground) 6%, transparent)',
                color: 'var(--color-muted-foreground)',
                border: '1px solid color-mix(in oklch, var(--color-border) 40%, transparent)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--color-primary)'
                e.currentTarget.style.borderColor = 'color-mix(in oklch, var(--color-glow-1) 30%, transparent)'
                e.currentTarget.style.background = 'color-mix(in oklch, var(--color-glow-1) 8%, transparent)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--color-muted-foreground)'
                e.currentTarget.style.borderColor = 'color-mix(in oklch, var(--color-border) 40%, transparent)'
                e.currentTarget.style.background = 'color-mix(in oklch, var(--color-muted-foreground) 6%, transparent)'
              }}
            >
              {name}
            </a>
          ))}
        </div>

        {/* Divider */}
        <div
          className="h-px w-full mb-6"
          style={{ background: 'var(--color-border)' }}
        />

        {/* Bottom bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs" style={{ color: 'var(--color-muted-foreground)' }}>
            © {year} KinBot. Released under{' '}
            <a
              href="https://github.com/MarlBurroW/kinbot/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors duration-200"
              style={{ color: 'var(--color-muted-foreground)' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-muted-foreground)' }}
            >
              AGPL-3.0
            </a>
            .
          </p>
          <p
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--color-muted-foreground)' }}
          >
            Made with
            <Heart size={12} style={{ color: 'var(--color-primary)' }} fill="var(--color-primary)" />
            by{' '}
            <a
              href="https://github.com/MarlBurroW"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 transition-colors duration-200"
              style={{ color: 'var(--color-muted-foreground)' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-muted-foreground)' }}
            >
              MarlBurroW
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}
