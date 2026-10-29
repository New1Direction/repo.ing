import { createNeuronChatHandler } from '../../lib/neuron-chat.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const handler = createNeuronChatHandler()
export const POST = handler
