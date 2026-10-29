import { notFound } from 'next/navigation'
import { NeuronCharacterPreview } from '../../../components/neurons-preview'
import { characterPersona, findPersona } from '../../../lib/neurons-preview.mjs'
import { publishedNeuronCharacters } from '../../../lib/neuron-publishing.mjs'
import { neuronChatConfiguration } from '../../../lib/neuron-chat.mjs'

export const dynamic = 'force-dynamic'
export default async function NeuronPage({ params }) {
  const { characterId } = await params
  const character = findPersona(characterId) ? null : await publishedNeuronCharacters(characterId)
  const persona = character ? characterPersona(character) : findPersona(characterId)
  if (!persona) notFound()
  const config = character?.personality ? neuronChatConfiguration() : null
  const chatConfig = config && character.personality.model.revision === config.modelRevision && character.personality.steering.alpha <= 1.25
    ? { genesisHash: config.genesisHash, botSiteKey: config.botSiteKey } : null
  return <NeuronCharacterPreview key={character?.id ?? persona.id} persona={persona} character={character} chatConfig={chatConfig}/>
}
