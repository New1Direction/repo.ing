import { permanentRedirect } from 'next/navigation'

// /parts is retired: a parts fund now lives on its market's token page, added by the verified maintainer. Old links
// (any ?state= tab included) land on Explore with a 308; the query is not carried over.
export function GET() {
  permanentRedirect('/explore')
}
