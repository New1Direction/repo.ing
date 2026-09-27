# Token artwork

[Documentation](README.md) / [Launch guide](USER_GUIDE.md#launch-a-repository-market)

## Choose an image

New launches start with a suggested image. **Change image** opens up to four candidates from GitHub-hosted README logos, a relevant asset directory, and the owner's avatar. Badges, screenshots, demos, banners, and sponsor images are excluded. PNG/SVG versions of the same named asset share a suggestion slot. Sources that cannot be downloaded or decoded are omitted.

**Upload image** accepts PNG, JPEG, WebP, or GIF up to 2 MB, at least 32 × 32 pixels, and at most 16 megapixels. GIFs use their first frame. Every selection becomes a static 512 × 512 PNG with the whole image fitted into the square. Transparent artwork gets a white or dark canvas chosen from its visible colors. The selected image appears in the token preview and launch review.

Suggestions can fail during a GitHub outage; uploading remains available. Invalid uploads leave the previous selection intact. Reviewing is disabled until an image is ready. The picker cannot change while a launch is being reviewed or signed.

## Persistence and compatibility

- The launch coordinator decodes and validates the prepared PNG, then saves it in the existing `markets.token_image` text column before requesting a wallet signature. The maximum saved binary size is 384 KiB. No schema migration or new credential is needed.
- `/api/token-metadata/{mint}` links new artwork to `/api/token-image/{mint}`. That endpoint serves the saved PNG with an immutable cache policy, content hash ETag, and `nosniff`.
- Market headers, Explore thumbnails, token metadata, and social share cards use the saved artwork. GitHub README/avatar changes do not alter it.
- A confirmed duplicate launch returns the existing market and cannot overwrite its image. Incomplete submitted/ambiguous launches retain their existing retry restrictions. A failed, unsigned review may be replaced through the ordinary retry flow.
- Existing markets without saved images keep the original repository-logo fallback. This release does not rewrite existing token artwork or provide a post-launch editing route.
- Image bytes live in PostgreSQL and are included in the existing encrypted database backup. No public permanent upload is created until the ordinary launch preparation stores the selected image. Preview uploads are processed in memory.

Image selection changes token artwork only. Canonical repository identity, GitHub ownership verification, launch config, fees, initial buy, and execution gates retain their existing rules.

## Input boundaries

Suggestions use a strict HTTPS GitHub image-host allowlist with credentials and custom ports rejected. Every redirect is revalidated; image requests carry no GitHub authorization header. Downloads are bounded to 2 MB. SVGs are accepted only from suggested GitHub sources, rejected for external references before decoding, and rasterized; uploaded SVGs are not accepted. Raster decode limits, processing timeouts, bounded caches, request concurrency limits, and same-origin upload checks apply. Stored launch input is decoded again server-side; arbitrary image URLs and SVG data URIs cannot be stored.

## Verification — September 27, 2026

- 23 focused checks passed: 11 launch-coordinator/database checks, 6 image processing/source-boundary checks, 4 existing logo/claim-progress checks, and 2 launch-cost checks.
- Image persistence was tested in a dedicated disposable PostgreSQL database on loopback port 55443. Tests prove the image is stored before signing and a duplicate launch cannot replace it.
- Actual local HTTP routes returned metadata pointing to the saved image, byte-identical stored/served artwork, immutable image headers, and HTTP 403 for a cross-origin upload.
- Local desktop and 390px mobile browser checks covered suggestions, selection/preview consistency, invalid upload recovery, successful upload, and light/dark presentation. Mobile document width equaled 390px.
- Production build passed. Three existing first-buy chain checks were attempted but could not run because the local Solana validator was unavailable (`fetch failed`). No first-buy instruction change was made. No mainnet launch or wallet transaction was sent for this verification.

## Production rollout

Implementation `f70fa70` deployed successfully to Railway web `9d0a1746-298b-47e0-a0bf-732075455a63` on September 27, 2026. No worker deployment, schema migration, config change, or economic activation was required.

Live Laya suggestions returned four valid PNGs (three project-logo variants and the actual owner avatar); the request completed in 1.129 seconds. The existing OHIYO token-image endpoint returned its expected legacy logo redirect. Laya's launch page correctly redirected to its already existing canonical market.

The live browser check used the ordinary lookup for `dream-num/univer` (repository ID `543101941`) and stopped before **Review launch**. Suggested image selection and a temporary test upload worked; the selected and side-preview images matched at 512 × 512. The suggested image was restored afterward. At 390px, document width was 390px. No market, launch intent, signature, or trading activity was created by this check; only ordinary repository metadata lookup and stateless image processing were exercised.
