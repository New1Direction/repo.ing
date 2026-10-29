import { NeuronPersonalityImport } from '../../../components/neuron-import'
import { neuronPublishingConfiguration } from '../../../lib/neuron-publishing.mjs'

export const dynamic = 'force-dynamic'
export default function NeuronImportPage() {
  const config = neuronPublishingConfiguration()
  return <NeuronPersonalityImport publishing={config ? { genesisHash: config.genesisHash, botSiteKey: config.botSiteKey } : null}/>
}
