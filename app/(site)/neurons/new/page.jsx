import { NeuronLaunchPreview } from '../../../components/neurons-preview'
import { findPersona } from '../../../lib/neurons-preview.mjs'
import { neuronPublishingConfiguration } from '../../../lib/neuron-publishing.mjs'

export const dynamic = 'force-dynamic'
export default async function NewNeuron({ searchParams }) {
  const { persona } = await searchParams
  const id = findPersona(persona)?.id ?? 'coffee-bean'
  const config = neuronPublishingConfiguration()
  return <NeuronLaunchPreview key={id} initialId={id} publishing={config ? { genesisHash: config.genesisHash, botSiteKey: config.botSiteKey } : null}/>
}
