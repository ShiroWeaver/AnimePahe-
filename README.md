# Stremio AnimePahe addon

A Stremio addon that reads AnimePahe's catalog, metadata and episode streams.

## Important service limitation

The addon uses the AnimePahe web/API endpoints directly. On November 21, 2026, the supplied
`animepahe.com` and `animepahe.org` addresses redirect to `animepahe.pw`. External checks
reported that `animepahe.pw` was returning a Cloudflare verification page / refusing
datacenter requests. Because this addon runs as a server-side Cloudflare Worker, it cannot
complete an interactive browser challenge.

The code now reports this situation explicitly instead of silently turning a challenge page
into empty catalog results. The addon cannot return fresh AnimePahe catalog data or streams
until the upstream site permits the addon's requests or provides an approved API/access method.
Changing between the three redirecting domains does not resolve that upstream restriction.

## Deploy your own Worker

This repository deploys with Alchemy to Cloudflare Workers.

1. Fork this repository or use your own copy.
2. Add these GitHub Actions repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_EMAIL`
   - `ALCHEMY_STATE_TOKEN`
3. Push or merge the changes to `main`. The workflow in `.github/workflows/deploy.yml`
   runs `bun install` and `bun alchemy deploy --stage prod`.
4. Copy the Worker URL shown in the successful deployment log.
5. In Stremio, open **Addons**, choose **Add addon**, and paste:
   `https://YOUR-WORKER-URL/manifest.json`

Do not use the former public worker URL from the upstream README as your personal deployment.

## Local development

Install Bun, then run:

```sh
bun install
bun run dev
```

## Changes in this maintenance branch

- Fetch and validate AnimePahe JSON/HTML responses with clear Cloudflare challenge errors.
- Encode search terms and anime IDs safely.
- Fetch every release API page, including the final page.
- Normalize poster/background URLs and avoid generating proxy links for missing images.
- Validate extracted HTTPS stream URLs and handle missing player options.
- Restrict the public image/stream proxy to expected AnimePahe, Kwik and UwU CDN hosts.
- Validate redirect destinations and remove the insecure global TLS-verification override.

## Reporting issues

Please include the Worker URL's failing route (for example `/manifest.json`, catalog, metadata or
stream), the HTTP status, and the Cloudflare error text. Do not include cookies, clearance tokens,
or other private session values.
