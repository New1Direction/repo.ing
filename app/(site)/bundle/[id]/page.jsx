import { notFound, permanentRedirect } from 'next/navigation'
import { bundleIdFrom } from '../../../../src/bundle-raise.mjs'

// Group launches were first called Bundles: an old raise link moves to its /group page.
export default async function OldBundlePage({ params }) {
  const { id } = await params
  const bundleId = bundleIdFrom(id)
  if (bundleId === null) notFound()
  permanentRedirect(`/group/${bundleId}`)
}
