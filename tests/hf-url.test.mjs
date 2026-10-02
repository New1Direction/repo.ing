import assert from 'node:assert/strict'
import test from 'node:test'
import { HfUrlError, hfModelUrl, isHfModelPath, isHfName, parseHfModelUrl } from '../src/hf-url.mjs'

test('model URLs, hf.co short links and bare owner/name ids parse to owner, name and path', () => {
  const gpt2 = { owner: 'openai-community', name: 'gpt2', path: 'openai-community/gpt2' }
  for (const input of [
    'https://huggingface.co/openai-community/gpt2',
    'https://huggingface.co/openai-community/gpt2/',
    'https://huggingface.co/openai-community/gpt2/tree/main/onnx',
    'https://huggingface.co/openai-community/gpt2/blob/main/config.json',
    'https://huggingface.co/openai-community/gpt2/discussions/184',
    'https://huggingface.co/openai-community/gpt2?library=transformers#model-card',
    'https://hf.co/openai-community/gpt2',
    'https://www.huggingface.co/openai-community/gpt2',
    'HTTPS://HuggingFace.co/openai-community/gpt2',
    'huggingface.co/openai-community/gpt2',
    'hf.co/openai-community/gpt2/resolve/main/config.json',
    '  openai-community/gpt2  ',
  ]) assert.deepEqual(parseHfModelUrl(input), gpt2, input)
  assert.deepEqual(parseHfModelUrl('https://huggingface.co/TheBloke/Llama-2-7B-GGUF'), { owner: 'TheBloke', name: 'Llama-2-7B-GGUF', path: 'TheBloke/Llama-2-7B-GGUF' })
  for (const path of ['stabilityai/stable-diffusion-xl-base-1.0', 'meta-llama/Llama-3.1-8B', 'stable-diffusion-v1-5/stable-diffusion-v1-5',
    '01-ai/Yi-34B', 'a/b', 'some_user/model_v2.1', `o/${'n'.repeat(96)}`]) {
    assert.equal(parseHfModelUrl(path).path, path)
  }
})

test('datasets, Spaces, collections and other Hub sections are refused with a clear reason', () => {
  const refused = (input, reason) => assert.throws(() => parseHfModelUrl(input), error => error instanceof HfUrlError && reason.test(error.message), input)
  refused('https://huggingface.co/datasets/openai/gsm8k', /not datasets/)
  refused('https://hf.co/datasets/openai/gsm8k/viewer', /not datasets/)
  refused('datasets/gsm8k', /not datasets/)
  refused('https://huggingface.co/spaces/stabilityai/stable-diffusion', /not Spaces/)
  refused('spaces/stable-diffusion', /not Spaces/)
  refused('https://huggingface.co/collections/meta-llama/llama-31-669fc079a0c406a149a5738f', /not collections/)
  refused('https://huggingface.co/Spaces/owner/name', /not Spaces/)
  refused('https://huggingface.co/docs/hub/repositories-settings', /not documentation/)
  refused('https://huggingface.co/models?search=gpt2', /not model listings/)
  refused('https://huggingface.co/api/models/openai-community/gpt2', /not API URLs/)
})

test('single segments, other hosts and schemes, credentials, ports and invalid names are refused', () => {
  for (const input of [
    'https://huggingface.co/gpt2', 'https://huggingface.co/', 'gpt2', 'openai-community/gpt2/extra', '/gpt2', 'openai-community/',
    'http://huggingface.co/openai-community/gpt2', 'https://huggingface.co.evil.example/openai-community/gpt2',
    'https://evil.example/huggingface.co/openai-community/gpt2', 'https://hub.huggingface.co/openai-community/gpt2',
    'https://user:pass@huggingface.co/openai-community/gpt2', 'https://huggingface.co:8443/openai-community/gpt2',
    'ftp://huggingface.co/openai-community/gpt2', 'hf://openai-community/gpt2', 'javascript:alert(1)',
    'openai-community/gpt--2', 'openai--community/gpt2', 'openai-community/gpt..2', 'openai-community/-gpt2', 'openai-community/gpt2-',
    'openai-community/.gpt2', 'openai-community/gpt2.', 'openai-community/gpt2.git', 'openai-community/gpt2.GIT', `o/${'n'.repeat(97)}`,
    'openai community/gpt2', 'openai-community/gpt 2', 'openai-community/gpt%202', 'https://huggingface.co/openai-community/gpt%2F2',
    'owner/модель', 'owner/name\u202e', '', '   ', 'x'.repeat(2049),
  ]) assert.throws(() => parseHfModelUrl(input), HfUrlError, JSON.stringify(input))
  for (const input of [null, undefined, 42, {}, ['openai-community/gpt2']]) assert.throws(() => parseHfModelUrl(input), HfUrlError)
})

test('path and name validators and canonical links follow the same rules', () => {
  assert.equal(isHfModelPath('openai-community/gpt2'), true)
  for (const value of ['gpt2', 'a/b/c', 'datasets/gsm8k', 'a/b.git', 'a/b--c', '', null]) assert.equal(isHfModelPath(value), false, String(value))
  assert.equal(isHfName('TheBloke'), true)
  assert.equal(isHfName('the_bloke.v2'), true)
  for (const value of ['-x', 'x-', 'a..b', 'a--b', 'é', '', 'a'.repeat(97), 5]) assert.equal(isHfName(value), false, String(value))
  assert.equal(hfModelUrl('openai-community/gpt2'), 'https://huggingface.co/openai-community/gpt2')
  assert.throws(() => hfModelUrl('spaces/x'), error => error instanceof HfUrlError && error.name === 'HfUrlError')
})
