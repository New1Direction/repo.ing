import { serializeJsonLd } from '../lib/json-ld.mjs'

export function JsonLd({ data }) { return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}/> }
