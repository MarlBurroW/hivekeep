import { useMemo, useState } from 'react'
import en from '../i18n/locales/en'

/**
 * Client-side install-command generator for the /install page.
 *
 * It owns no network calls, it just turns a few choices into the exact
 * `docker run` / `docker-compose.yml` + `.env` / `install.sh` invocation,
 * plus a reverse-proxy snippet for the "public domain" case.
 *
 * Canonical facts it encodes (keep in sync with docker/ + install.sh):
 *  - image:        ghcr.io/marlburrow/hivekeep
 *  - data volume:  /app/data  (MUST persist: holds the auto-generated
 *                  encryption key; lose it and every vault secret is gone)
 *  - app port:     3000 inside the container; install.sh default 3000
 *  - install.sh:   reads HIVEKEEP_PORT / HIVEKEEP_PUBLIC_URL
 *
 * i18n: every user-visible string comes from the `labels` prop
 * (t.install.configurator in the locale dictionary), defaulting to English.
 * Rich strings carry inline HTML + {port}/{url}/{host} placeholders.
 */

const IMAGE = 'ghcr.io/marlburrow/hivekeep'
const INSTALL_SH = 'https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh'

type Labels = typeof en.install.configurator

type UseCase = 'try' | 'permanent' | 'server'
type Method = 'docker' | 'native'
type Proxy = 'caddy' | 'nginx' | 'own'
type DockerTab = 'run' | 'compose'

const USE_CASE_IDS: UseCase[] = ['try', 'permanent', 'server']

function CopyButton({ text, labels }: { text: string; labels: Labels }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`cfg-copy${done ? ' done' : ''}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
          // Conversion signal: copying a configured install command.
          try { (window as any).umami?.track('Install Copy', { source: 'configurator' }) } catch { /* analytics absent */ }
        } catch {
          /* clipboard blocked: no-op */
        }
      }}
      aria-label={labels.copyAria}
    >
      {done ? labels.copied : labels.copy}
    </button>
  )
}

function CodeBlock({ title, code, lang, labels }: { title?: string; code: string; lang?: string; labels: Labels }) {
  return (
    <div className="cfg-block">
      {title && (
        <div className="cfg-block-head">
          <span className="cfg-block-title">
            {title}
            {lang && <span className="cfg-lang">{lang}</span>}
          </span>
          <CopyButton text={code} labels={labels} />
        </div>
      )}
      <pre className="cfg-code">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function randomKey() {
  // 32 bytes -> 64 hex chars, matching ENCRYPTION_KEY format.
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export default function InstallConfigurator({ labels = en.install.configurator }: { labels?: Labels }) {
  const [useCase, setUseCase] = useState<UseCase>('try')
  const [method, setMethod] = useState<Method>('native')
  const [port, setPort] = useState('3000')
  const [lanAccess, setLanAccess] = useState(false)
  const [host, setHost] = useState('')
  const [proxy, setProxy] = useState<Proxy>('caddy')
  const [setKey, setSetKey] = useState(false)
  const [key, setKey_] = useState('')
  const [dockerTab, setDockerTab] = useState<DockerTab>('run')

  // Picking a use case resets method + tab to that case's sensible default.
  // Native is the recommended default everywhere (it builds locally and needs
  // no published image); the server case leans on docker compose by convention,
  // but the method toggle stays available so anyone can switch.
  function pickUseCase(uc: UseCase) {
    setUseCase(uc)
    if (uc === 'try') {
      setMethod('native')
    } else if (uc === 'permanent') {
      setMethod('native')
    } else {
      setMethod('native')
      setDockerTab('compose')
    }
  }

  const isServer = useCase === 'server'
  const portN = port.trim() || '3000'

  // The public URL the user will actually reach the app at.
  const publicUrl = useMemo(() => {
    if (isServer) return `https://${host.trim() || 'hivekeep.example.com'}`
    if (useCase === 'permanent' && lanAccess) return `http://${host.trim() || '192.168.1.50'}:${portN}`
    return `http://localhost:${portN}`
  }, [isServer, useCase, lanAccess, host, portN])

  const isDefaultUrl = publicUrl === `http://localhost:${portN}`
  // Behind a reverse proxy we bind the port to loopback so the app isn't
  // exposed directly; otherwise bind normally.
  const loopbackBind = isServer
  const portMap = loopbackBind ? `127.0.0.1:${portN}:3000` : `${portN}:3000`

  const dockerRun = useMemo(() => {
    const parts = ['docker run -d', '--name hivekeep', `-p ${portMap}`, '-v hivekeep-data:/app/data']
    if (!isDefaultUrl) parts.push(`-e PUBLIC_URL=${publicUrl}`)
    if (setKey && key) parts.push(`-e ENCRYPTION_KEY=${key}`)
    parts.push(IMAGE)
    return parts.join(' \\\n  ')
  }, [portMap, isDefaultUrl, publicUrl, setKey, key])

  const composeYml = useMemo(
    () =>
      [
        'services:',
        '  hivekeep:',
        `    image: ${IMAGE}:latest`,
        '    container_name: hivekeep',
        '    restart: unless-stopped',
        '    ports:',
        `      - "${portMap}"`,
        '    volumes:',
        '      - hivekeep-data:/app/data',
        '    env_file: .env',
        'volumes:',
        '  hivekeep-data:',
      ].join('\n'),
    [portMap],
  )

  const envFile = useMemo(() => {
    const lines = [
      labels.envComments.publicUrl,
      `PUBLIC_URL=${publicUrl}`,
      '',
      labels.envComments.key1,
      labels.envComments.key2,
      labels.envComments.key3,
      setKey && key ? `ENCRYPTION_KEY=${key}` : '# ENCRYPTION_KEY=',
    ]
    return lines.join('\n')
  }, [publicUrl, setKey, key, labels])

  const nativeCmd = useMemo(() => {
    const env: string[] = []
    if (portN !== '3000') env.push(`HIVEKEEP_PORT=${portN}`)
    if (!isDefaultUrl) env.push(`HIVEKEEP_PUBLIC_URL=${publicUrl}`)
    if (setKey && key) env.push(`ENCRYPTION_KEY=${key}`)
    if (env.length === 0) return `curl -fsSL ${INSTALL_SH} | bash`
    return `${env.join(' ')} \\\n  bash <(curl -fsSL ${INSTALL_SH})`
  }, [portN, isDefaultUrl, publicUrl, setKey, key])

  const caddyfile = useMemo(
    () => `${host.trim() || 'hivekeep.example.com'} {\n    reverse_proxy localhost:${portN}\n}`,
    [host, portN],
  )

  const nginxConf = useMemo(
    () =>
      [
        'server {',
        '    listen 80;',
        `    server_name ${host.trim() || 'hivekeep.example.com'};`,
        '',
        '    location / {',
        `        proxy_pass http://localhost:${portN};`,
        '        proxy_http_version 1.1;',
        '        proxy_set_header Host $host;',
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '        proxy_set_header X-Forwarded-Proto $scheme;',
        `        ${labels.nginxComments.sse}`,
        '        proxy_set_header Connection \'\';',
        '        proxy_buffering off;',
        '    }',
        '}',
        '',
        labels.nginxComments.https.replace('{host}', host.trim() || 'hivekeep.example.com'),
      ].join('\n'),
    [host, portN, labels],
  )

  return (
    <div className="cfg">
      {/* Step 1: use case */}
      <div className="cfg-step">
        <h3>{labels.step1}</h3>
        <div className="cfg-opts">
          {USE_CASE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`cfg-opt${useCase === id ? ' sel' : ''}`}
              onClick={() => pickUseCase(id)}
            >
              <span className="cfg-opt-label">{labels.useCases[id].label}</span>
              <span className="cfg-opt-hint">{labels.useCases[id].hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Step 2: settings */}
      <div className="cfg-step">
        <h3>{labels.step2}</h3>
        <div className="cfg-fields">
          {/* method: native is recommended; Docker stays available with a caveat */}
          <div className="cfg-field">
            <label>{labels.method}</label>
            <div className="cfg-seg">
              <button type="button" className={method === 'native' ? 'sel' : ''} onClick={() => setMethod('native')}>
                {labels.methodNative}
              </button>
              <button type="button" className={method === 'docker' ? 'sel' : ''} onClick={() => setMethod('docker')}>
                {labels.methodDocker}
              </button>
            </div>
          </div>

          <div className="cfg-field">
            <label htmlFor="cfg-port">{labels.port}</label>
            <input
              id="cfg-port"
              type="text"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="3000"
            />
          </div>

          {useCase === 'permanent' && (
            <div className="cfg-field">
              <label>
                <input type="checkbox" checked={lanAccess} onChange={(e) => setLanAccess(e.target.checked)} />{' '}
                {labels.lanAccess}
              </label>
              {lanAccess && (
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={labels.lanPlaceholder}
                />
              )}
            </div>
          )}

          {isServer && (
            <div className="cfg-field">
              <label htmlFor="cfg-domain">{labels.domain}</label>
              <input
                id="cfg-domain"
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="hivekeep.example.com"
              />
            </div>
          )}

          {isServer && (
            <div className="cfg-field">
              <label>{labels.reverseProxy}</label>
              <div className="cfg-seg">
                <button type="button" className={proxy === 'caddy' ? 'sel' : ''} onClick={() => setProxy('caddy')}>
                  Caddy
                </button>
                <button type="button" className={proxy === 'nginx' ? 'sel' : ''} onClick={() => setProxy('nginx')}>
                  nginx
                </button>
                <button type="button" className={proxy === 'own' ? 'sel' : ''} onClick={() => setProxy('own')}>
                  {labels.proxyOwn}
                </button>
              </div>
            </div>
          )}

          {/* advanced: explicit encryption key */}
          <div className="cfg-field cfg-adv">
            <label>
              <input
                type="checkbox"
                checked={setKey}
                onChange={(e) => {
                  setSetKey(e.target.checked)
                  if (e.target.checked && !key) setKey_(randomKey())
                }}
              />{' '}
              {labels.fixedKey}
            </label>
            {setKey && (
              <div className="cfg-keyrow">
                <input type="text" value={key} onChange={(e) => setKey_(e.target.value)} spellCheck={false} />
                <button type="button" className="cfg-mini" onClick={() => setKey_(randomKey())}>
                  {labels.generate}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 3: output */}
      <div className="cfg-step">
        <h3>{labels.step3}</h3>

        {method === 'docker' ? (
          <>
            {/* Honest caveat: the published image is not available yet. */}
            <div className="cfg-warn">
              <strong>{labels.dockerWarn.title}</strong>
              <span>
                {labels.dockerWarn.beforeImage}
                <code>{IMAGE}</code>
                {labels.dockerWarn.afterImage}
                <code>manifest unknown</code>
                {labels.dockerWarn.or}
                <code>denied</code>
                {labels.dockerWarn.beforeLink}
                <button type="button" className="cfg-inline-link" onClick={() => setMethod('native')}>
                  {labels.dockerWarn.link}
                </button>
                {labels.dockerWarn.afterLink}
              </span>
            </div>
            <div className="cfg-tabs">
              <button type="button" className={dockerTab === 'run' ? 'sel' : ''} onClick={() => setDockerTab('run')}>
                docker run
              </button>
              <button type="button" className={dockerTab === 'compose' ? 'sel' : ''} onClick={() => setDockerTab('compose')}>
                docker compose
              </button>
            </div>
            {dockerTab === 'run' ? (
              <>
                <CodeBlock title={labels.blockRun} lang="shell" code={dockerRun} labels={labels} />
                <p className="cfg-note cfg-keynote" dangerouslySetInnerHTML={{ __html: labels.dockerKeynote }} />
              </>
            ) : (
              <>
                <CodeBlock title="docker-compose.yml" lang="yaml" code={composeYml} labels={labels} />
                <CodeBlock title=".env" lang="env" code={envFile} labels={labels} />
                <CodeBlock title={labels.blockStart} lang="shell" code="docker compose up -d" labels={labels} />
                <p className="cfg-note cfg-keynote" dangerouslySetInnerHTML={{ __html: labels.composeKeynote }} />
              </>
            )}
            {/* Recovery notes for the common non-dev Docker failures. */}
            <div className="cfg-recover">
              <span className="cfg-recover-head">{labels.dockerRecover.head}</span>
              <ul>
                <li dangerouslySetInnerHTML={{ __html: labels.dockerRecover.port.replace('{port}', portN) }} />
                <li>
                  <code>manifest unknown</code> / <code>denied</code>: {labels.dockerRecover.manifest.before}
                  <button type="button" className="cfg-inline-link" onClick={() => setMethod('native')}>
                    {labels.dockerRecover.manifest.link}
                  </button>
                  {labels.dockerRecover.manifest.after}
                </li>
                <li dangerouslySetInnerHTML={{ __html: labels.dockerRecover.daemon }} />
              </ul>
            </div>
          </>
        ) : (
          <>
            <CodeBlock title={labels.blockInstall} lang="shell" code={nativeCmd} labels={labels} />
            <p className="cfg-note cfg-keynote" dangerouslySetInnerHTML={{ __html: labels.nativeKeynote }} />
            {/* Recovery notes for the common native failures. */}
            <div className="cfg-recover">
              <span className="cfg-recover-head">{labels.nativeRecover.head}</span>
              <ul>
                <li dangerouslySetInnerHTML={{ __html: labels.nativeRecover.port.replace('{port}', portN) }} />
                <li dangerouslySetInnerHTML={{ __html: labels.nativeRecover.windows }} />
                <li dangerouslySetInnerHTML={{ __html: labels.nativeRecover.network }} />
              </ul>
            </div>
          </>
        )}

        {/* reverse proxy snippet for the public-domain case */}
        {isServer && (
          <div className="cfg-proxy">
            {proxy === 'caddy' && (
              <>
                <p className="cfg-note" dangerouslySetInnerHTML={{ __html: labels.proxyCaddy }} />
                <CodeBlock title="Caddyfile" code={caddyfile} labels={labels} />
              </>
            )}
            {proxy === 'nginx' && (
              <>
                <p className="cfg-note" dangerouslySetInnerHTML={{ __html: labels.proxyNginx }} />
                <CodeBlock title="/etc/nginx/sites-available/hivekeep" code={nginxConf} labels={labels} />
              </>
            )}
            {proxy === 'own' && (
              <p
                className="cfg-note"
                dangerouslySetInnerHTML={{
                  __html: labels.proxyOwnNote.replace('{port}', portN).replace('{url}', publicUrl),
                }}
              />
            )}
          </div>
        )}

        <p className="cfg-foot" dangerouslySetInnerHTML={{ __html: labels.foot.replace('{url}', publicUrl) }} />
      </div>
    </div>
  )
}
