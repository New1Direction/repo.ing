import { notFound } from 'next/navigation'
import { NeuronCharacterPreview } from '../../../components/neurons-preview'
import { findPersona } from '../../../lib/neurons-preview.mjs'
import { publishedNeuronCharacters } from '../../../lib/neuron-publishing.mjs'

export const dynamic = 'force-dynamic'
export default async function NeuronPage({ params }) {
  const { characterId } = await params
  const character = findPersona(characterId) ? null : await publishedNeuronCharacters(characterId)
  const persona = findPersona(character?.personaId ?? characterId)
  if (!persona) notFound()
  return <NeuronCharacterPreview key={character?.id ?? persona.id} persona={persona} character={character}/>
}
