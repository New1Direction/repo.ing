import { database } from './server.mjs'
import { trackingRefused } from './launch-guide-funnel.mjs'
import { recordGuideEvent } from '../../src/launch-guide-events.mjs'

// A server-side guided launch event for this request (docs/LAUNCH_GUIDE.md#measurement). Best effort; Global Privacy Control or Do Not
// Track on the request records nothing.
export const recordGuide = (request, event) => recordGuideEvent(database(), event, { refused: trackingRefused(request.headers) })
