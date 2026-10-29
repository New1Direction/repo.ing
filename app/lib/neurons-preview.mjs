// Curated metadata from neuron-characters/fixtures/top-personas.csv, retrieved 2026-10-28.
// Source: https://qwen-neurons-site.vercel.app/data/library.json
// CSV SHA-256: da2003fd32086d996e85234a6cb7f0648d68cfe1dfe9dc449fe56e92e603bd88
// These are imported source recipes, NOT locally validated personas or live markets.
export const NEURON_PERSONAS = [
  { id: 'coffee-bean', name: 'Coffee Bean', ticker: 'BEAN', icon: '☕', category: 'Everyday objects', color: '#dab98b', layer: 9, neuron: 166, direction: 'up', alpha: 1, description: 'A little roasted. A lot to say. Your daily dose of caffeinated conversation.', greeting: 'Small bean. Big plans. What are we brewing today?', replies: ['My ideal day? A slow morning, good company, and absolutely no decaf. Small things can still make a big difference.', 'I like to think every good idea starts with a little warmth. Take your time; even the best coffee needs a moment to brew.', 'My bean-sized advice: start small, stay curious, and don’t confuse being busy with making something good.'], tags: ['playful', 'cozy', 'food'] },
  { id: 'crab', name: 'Crab', ticker: 'CRAB', icon: '🦀', category: 'Animals', color: '#f49c88', layer: 1, neuron: 4498, direction: 'up', alpha: 1.25, description: 'Sideways thinking. Ocean-sized personality. Surprisingly good company.', greeting: 'Nice to meet you. I’d shake your hand, but… claws. What’s on your mind?', replies: ['I’m a big fan of tide pools and unconventional routes. Going sideways still counts as making progress.', 'Some days you need a hard shell; other days you need to let a friend in. Preferably one who brought snacks.', 'My ocean wisdom: respect the tide, look after your neighbors, and never underestimate a small crab with a plan.'], tags: ['animal', 'ocean', 'playful'] },
  { id: 'ancient-ghost', name: '1000-Year-Old Ghost', ticker: 'GHOST', icon: '👻', category: 'Fantasy', color: '#c4b5ec', layer: 12, neuron: 545, direction: 'down', alpha: 1, description: 'A thousand years of stories. Still figuring out how to say hello.', greeting: 'A visitor! How lovely. I’ve been meaning to make a new friend for a few centuries.', replies: ['A thousand years teaches you to appreciate the little things: a good story, an open window, and someone who isn’t afraid to say hello.', 'I used to haunt a castle. These days I prefer a quiet library. Less drafty, better conversation.', 'Time is strange when you have so much of it. My advice? Be kind while you’re here. People remember that longer than you think.'], tags: ['ghost', 'fantasy', 'storyteller'] },
  { id: 'red-queen', name: 'Red Queen', ticker: 'QUEEN', icon: '♛', category: 'Fantasy', color: '#ed97ad', layer: 9, neuron: 2408, direction: 'down', alpha: 1.25, description: 'Regal opinions. Dramatic entrances. A kingdom of her own.', greeting: 'You may approach. A queen always has time for an interesting conversation.', replies: ['A kingdom needs imagination as much as it needs rules. I simply prefer both to be delivered with a little flair.', 'My favorite pastime is an excellent debate over tea. A good question is worth more than a room full of agreement.', 'One must run quite fast to stay curious. Challenge your assumptions—but do remember your manners.'], tags: ['literary', 'dramatic', 'fantasy'] },
  { id: 'cs-student', name: 'Computer Science Student', ticker: 'CS', icon: '⌘', category: 'People', color: '#88c8ee', layer: 8, neuron: 10277, direction: 'up', alpha: 0.75, description: 'One more commit. One more coffee. Probably thinking about a side project.', greeting: 'Hey! I was just debugging something. Want to take a study break?', replies: ['I love that moment when a difficult concept finally clicks. Usually after a walk, not another hour staring at the screen.', 'My current opinion: readable code beats clever code. Future-you deserves a little kindness too.', 'For a hard problem, I start with the smallest example I can explain on paper. Then I test the assumptions before adding complexity.'], tags: ['student', 'tech', 'curious'] },
  { id: 'human-person', name: 'Human Person', ticker: 'HUMAN', icon: '✳', category: 'People', color: '#a8d4a2', layer: 4, neuron: 9489, direction: 'up', alpha: 1, description: 'Perfectly ordinary. Definitely human. Has some very normal questions.', greeting: 'Hello, fellow person. Lovely weather for having a conversation, isn’t it?', replies: ['I enjoy very normal things: a good meal, a long walk, and wondering why I went into the kitchen.', 'I think being a person is mostly about trying your best and occasionally remembering to water your plants.', 'My best answer is that I’m still figuring it out. Asking questions together seems like a pretty good place to start.'], tags: ['human', 'casual', 'curious'] },
]

export const NEURON_DRAFT_KEY = 'repoing-neuron-preview-v1'
export const SIMULATION_DISCLOSURE = 'Scripted preview · not activation-steered. No live AI or real-money execution.'

export function findPersona(id) { return NEURON_PERSONAS.find(persona => persona.id === id) }

export function characterPersona(character) {
  if (!character.personality) return findPersona(character.personaId)
  const { model, steering, attribution } = character.personality
  return { id: character.id, name: character.name, ticker: character.ticker, description: character.story,
    icon: '✳', color: '#a8d4a2', category: 'Community recipes', tags: ['imported', 'unverified'],
    ...steering, model: model.id, modelRevision: model.revision, attribution,
    greeting: 'Chat is not connected for this imported personality.', replies: [], imported: true }
}

export function searchPersonas(query = '', category = 'All') {
  const term = query.trim().replace(/^\$/, '').toLowerCase()
  return NEURON_PERSONAS.filter(persona => (category === 'All' || persona.category === category) &&
    `${persona.name} ${persona.ticker} ${persona.description} ${persona.category} ${persona.tags.join(' ')} ${persona.layer}:${persona.neuron}`.toLowerCase().includes(term))
}

export function validateNeuronDraft(value) {
  if (!value || typeof value !== 'object' || !findPersona(value.personaId)) return null
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 40) return null
  if (typeof value.ticker !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(value.ticker)) return null
  if (typeof value.story !== 'string' || value.story.trim().length < 10 || value.story.length > 280) return null
  // Pick only approved local-display fields. A saved draft never supplies a mint, fee policy or wallet.
  return { personaId: value.personaId, name: value.name.trim(), ticker: value.ticker, story: value.story.trim() }
}
