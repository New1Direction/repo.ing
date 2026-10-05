import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appModule, h, html } from './fixtures/render-jsx.mjs'

const { RepoAvatar, RepoIdentity } = await appModule('app/components/ui.jsx')
const { LaunchTokenAvatar, LaunchTokenImageContext } = await appModule('app/components/launch-token-image.jsx')
const repo = { repoId: '1388219884', owner: 'New1Direction', name: 'repo.ing', fullName: 'New1Direction/repo.ing' }
const picked = 'data:image/png;base64,iVBORw0KGgo='
const top = () => h(RepoIdentity, { repo, avatar: h(LaunchTokenAvatar, null, h(RepoAvatar, { repo, size: 'large' })) })
const withImage = (image, element) => h(LaunchTokenImageContext.Provider, { value: { image, setImage() {} } }, element)

test('the launch page\'s top icon is the repository\'s own until a token image is picked', () => {
  const markup = html(top())
  assert.match(markup, /\/api\/repo-logo\/1388219884\?v=3&amp;w=256/)
  assert.equal(markup, html(h(RepoIdentity, { repo })), 'the same markup as without the override')
})

test('once the launcher picks or uploads an image, the top icon shows it', () => {
  const markup = html(withImage(picked, top()))
  assert.match(markup, /<div class="repo-avatar large"><img src="data:image\/png;base64,iVBORw0KGgo="/)
  assert.doesNotMatch(markup, /repo-logo/)
})

test('the launch page shares one picked image between the launch form and the top icon', () => {
  const page = readFileSync(new URL('../app/(site)/launch/[repo]/page.jsx', import.meta.url), 'utf8')
  const open = page.indexOf('<LaunchTokenImageProvider>'), close = page.indexOf('</LaunchTokenImageProvider>')
  assert.ok(open > 0 && open < page.indexOf('avatar={<LaunchTokenAvatar>') && page.indexOf('<LaunchForm ') < close, 'the provider wraps the top icon and the form')
  const form = readFileSync(new URL('../app/components/launch-form.jsx', import.meta.url), 'utf8')
  assert.match(form, /useShareLaunchTokenImage\(tokenImage\?\.image\)/)
})
