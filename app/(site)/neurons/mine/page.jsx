import { MyNeuronCharacters } from '../../../components/neuron-publishing'
import { neuronPublishingConfiguration } from '../../../lib/neuron-publishing.mjs'
import { notFound } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function MyNeurons() {
  const config = neuronPublishingConfiguration()
  if (!config) notFound()
  return <MyNeuronCharacters genesisHash={config.genesisHash}/>
}
