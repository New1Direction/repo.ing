import { NeuronsLibrary } from '../../components/neurons-preview'
import { publishedNeuronCharacters } from '../../lib/neuron-publishing.mjs'

export const dynamic = 'force-dynamic'
export default async function NeuronsPage() {
  let characters = [], unavailable = false
  try { characters = await publishedNeuronCharacters() } catch { unavailable = true }
  return <NeuronsLibrary publishedCharacters={characters} publishingEnabled={process.env.NEURONS_PUBLISHING_ENABLED === 'true'} publishingUnavailable={unavailable}/>
}
