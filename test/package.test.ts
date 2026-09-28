import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  type: string
  main: string
  types: string
  files: string[]
  dsh: unknown
}
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const design = await readFile(new URL('../docs/superpowers/specs/2026-08-26-chatgpt-web-v0.1-design.md', import.meta.url), 'utf8')
const plan = await readFile(new URL('../docs/superpowers/plans/2026-08-26-chatgpt-web-v0.1-implementation.md', import.meta.url), 'utf8')
const smoke = await readFile(new URL('../docs/manual-smoke.md', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')) as {
  manifest_version: number
  key: string
  permissions: string[]
  host_permissions: string[]
  content_scripts: Array<{ matches: string[]; js: string[] }>
}

test('package is an installable DSH bundle', () => {
  assert.equal(pkg.name, 'dsh-chatgpt-web')
  assert.equal(pkg.version, '0.1.1-solis.1')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.types, './lib/index.d.ts')
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('extension'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.files.some(file => file.includes('.github')), false)
})

test('bundle patch mounts one runtime row and never exposes a public bind', () => {
  assert.match(patch, /id:\s*llm-chatgpt-web/)
  assert.match(patch, /name:\s*dsh-chatgpt-web/)
  assert.doesNotMatch(patch, /0\.0\.0\.0/)
})

test('extension permissions stay scoped to ChatGPT and loopback', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.ok(manifest.key.length > 100)
  assert.deepEqual(manifest.permissions.sort(), ['storage', 'tabs'])
  assert.deepEqual(manifest.host_permissions.sort(), ['http://127.0.0.1/*', 'https://chatgpt.com/*'])
  assert.deepEqual(manifest.content_scripts[0]?.matches, ['https://chatgpt.com/*'])
  assert.deepEqual(manifest.content_scripts[0]?.js, ['chatgpt-page-adapter.js', 'content-script.js'])
})

test('README documents install, limitations, privacy, and local-only verification', () => {
  assert.match(readme, /dsh plugin --profile chatgpt-web-compat add \./)
  assert.match(readme, /dsh plugin --profile web add dsh-chatgpt-web/)
  assert.match(readme, /chatgpt-web\/auto/)
  assert.match(readme, /chrome:\/\/extensions/)
  assert.match(readme, /Load unpacked/i)
  assert.match(readme, /No OpenAI API key/i)
  assert.match(readme, /text-only/i)
  assert.match(readme, /one dedicated Chrome worker tab/i)
  assert.match(readme, /tool schemas.*not callable/is)
  assert.match(readme, /never enumerates the ChatGPT sidebar/i)
  assert.match(readme, /npm run check/)
  assert.match(readme, /npm test/)
  assert.match(readme, /no GitHub Actions or CI workflow/i)
})

test('current documentation uses authoritative-completion-only v0.1 semantics', () => {
  for (const document of [readme, design, plan, smoke]) {
    assert.match(document, /authoritative/i)
    assert.match(document, /generation-complete/i)
  }

  assert.match(readme, /work in progress/i)
  assert.match(readme, /browser `delta` events are \*\*internal transport observations only\*\*/i)
  assert.match(design, /`open-session` and `reset-session` are \*\*not\*\* separate wire messages/i)
  assert.match(design, /There is no separate `generation-start` wire event/i)
  assert.match(plan, /browser deltas are no longer DSH text deltas/i)
  assert.match(smoke, /Do not expect token-by-token DSH streaming in v0\.1/i)

  assert.doesNotMatch(readme, /v0\.1 provides text generation, live streaming/i)
  assert.doesNotMatch(smoke, /verify clean native DSH streaming/i)
})

test('current documentation records the resolved premature-completion blocker and remaining packed-install gate', () => {
  for (const document of [readme, design, plan, smoke]) {
    assert.match(document, /premature/i)
    assert.match(document, /completion/i)
    assert.match(document, /resolved/i)
  }

  assert.match(readme, /packed-install/i)
  assert.match(plan, /packed-install/i)
  assert.match(smoke, /packed-install/i)
  assert.doesNotMatch(readme, /current live blocker/i)
  assert.doesNotMatch(design, /Current open blocker: premature completion/i)
  assert.doesNotMatch(plan, /release acceptance is blocked by premature browser completion detection/i)
  assert.doesNotMatch(smoke, /Do not mark v0\.1 accepted yet/i)
})
