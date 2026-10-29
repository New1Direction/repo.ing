import { createNeuronPublishingHandler } from '../../lib/neuron-publishing.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const handler = createNeuronPublishingHandler()
export const GET = handler
export const POST = handler
