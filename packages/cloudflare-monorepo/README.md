# nitro-cloudflare-monorepo

A Nitro preset that runs a Nuxt/Nitro app **and every sibling Cloudflare Worker
in the repository** inside a single Miniflare instance, so that cross-script
Durable Object bindings, service bindings, D1, R2 and containers resolve in
`nuxt dev` exactly as they do once deployed.

Part of [nitro-cf-monorepo](../../README.md), which is a working example of it.

## The problem

`nuxt dev` runs on Node. Your deployed Worker runs on workerd. Bindings are
where that difference shows, and some of them fail in ways that are quiet rather
than loud:

- A `services` entry in `wrangler.jsonc` deploys correctly but is simply
  **absent** from `event.context.cloudflare.env` in dev. The worker gets
  bundled, the logs look right, and the binding is missing.
- A cross-script Durable Object binding has no local counterpart at all unless
  the other worker is running in the same Miniflare instance.
- Containers are Docker images, so nothing in the bundling path produces them.
- A WebSocket to a Durable Object cannot be answered from a Nitro route at all.
  Nitro rebuilds every handler's return value into a fresh `Response`, and
  `new Response(null, { status: 101 })` throws — so the usual workaround is to
  give that worker its own public hostname, which is a second public surface
  and a second thing to protect.

The usual answer is to run several `wrangler dev` processes and point them at
each other. That works until you want one command, one persist directory, and
bindings that behave the same in both places.

## Install

```bash
pnpm add -D nitro-cloudflare-monorepo
```

`nitropack`, `wrangler` and `miniflare` are peer dependencies. `esbuild` and
`chokidar` must be resolvable **from your app's directory** — the preset
resolves them from the project root at runtime to bundle and watch auxiliary
workers.

## Use

```ts
// nuxt.config.ts
import type {} from 'nitro-cloudflare-monorepo'

export default defineNuxtConfig({
    nitro: {
        preset: 'cloudflare-module',
        extends: ['nitro-cloudflare-monorepo'],
        cloudflareMonorepo: {
            workers: [
                { configPath: '../services/board/wrangler.jsonc' },
                {
                    configPath: '../services/imgman/wrangler.jsonc',
                    // Optional: runs before the container image is built, for
                    // build steps the Dockerfile cannot do itself.
                    prepare: 'pnpm -C ../services/imgman sync-assets',
                },
            ],
        },
    },
})
```

**Both `preset` and `extends` are required, and this is not redundancy.** Nitro
resolves presets through an internal registry _before_ it loads external
packages, so in dev an external preset is silently ignored and replaced with
`nitro-dev`. `preset` must name a built-in so the production build is correct;
`extends` is what actually loads the dev module.

### Options

| Option        | Default              | Meaning                                                                                                                                                                   |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`     | `[]`                 | Auxiliary workers to load. Each needs a `configPath`; `name` overrides the one in the wrangler config, `prepare` runs a shell command before the container image is built |
| `configPath`  | auto-detected        | The app's own wrangler config                                                                                                                                             |
| `persistDir`  | `.wrangler/state/v3` | Where Miniflare keeps D1, R2, KV and DO state                                                                                                                             |
| `environment` | none                 | Wrangler environment to read from the configs                                                                                                                             |

With **no** auxiliary workers the preset still starts Miniflare for the app's
own bindings, so it is useful for a plain Nuxt app with a D1 database.

## What it does

**Build time** ([`src/dev.ts`](src/dev.ts)) — reads each auxiliary worker's
wrangler config, bundles its entry with esbuild, and builds any container images
it declares.

**Run time** ([`src/runtime/plugin.dev.ts`](src/runtime/plugin.dev.ts)) — starts
one Miniflare instance holding a stub main worker that carries your app's
bindings plus every auxiliary worker, injects
`event.context.cloudflare.env` on each request, and re-bundles and hot-swaps
auxiliary workers when their sources change. The stub main worker also answers
WebSocket upgrades using your `upgrade` module — Nitro serves HTTP from Node in
development and Node cannot return a workerd socket — and the instance's origin
is published on `globalThis.__miniflareOrigin__` so the app can point a browser
at it.

**Production** ([`src/preset.ts`](src/preset.ts)) — replaces the worker entry
with one that calls your `upgrade` module before delegating to Nitro
([`src/runtime/entry.prod.ts`](src/runtime/entry.prod.ts)), and rewrites Nitro's
`preview` command to a `wrangler dev -c … -c …` spanning every config, so
`nuxt preview` gets the same topology.

## Notes worth knowing

**WebSockets reach a Durable Object without giving it a hostname.** Point
`upgrade` at a module and it is called for any request carrying
`Upgrade: websocket`, above Nitro, in every environment:

```ts
// nuxt.config.ts
nitro: {
    cloudflareMonorepo: {
        workers: [{ configPath: '../services/room/wrangler.jsonc' }],
        upgrade: './server/upgrade.ts',
    },
}
```

```ts
// server/upgrade.ts — return a Response to answer, or nothing to fall through
export default function (request: Request, env: { ROOM: DurableObjectNamespace }) {
    const match = /^\/api\/rooms\/([^/]+)\/socket$/.exec(new URL(request.url).pathname)
    if (!match) return
    return env.ROOM.get(env.ROOM.idFromName(match[1]!)).fetch(request)
}
```

The auxiliary worker stays `workers_dev: false` with no routes. Your app is the
only thing with a hostname, and the socket arrives on its origin — which also
means one access policy covers it, rather than one that has to be told about a
second hostname and silently breaks the socket if it is not.

**In development the socket has a different origin, and only the origin.** Nitro
serves HTTP from Node under `nuxt dev`, and Node cannot return a workerd
`WebSocketPair`, so Miniflare answers the upgrade instead — same module, same
binding, same path, different port. Read it from
`globalThis.__miniflareOrigin__` and substitute it:

```ts
const devOrigin = (globalThis as Record<string, unknown>).__miniflareOrigin__ as string | undefined
const origin = devOrigin ?? getRequestURL(event).origin
return { url: `${origin.replace(/^http/, 'ws')}/api/rooms/${id}/socket` }
```

Under `wrangler dev` — what `nuxt preview` runs — there is no dev origin and
none is needed: the production entry answers the upgrade on the app's own
origin, exactly as deployed.

**Read the origin every time, not once.** Miniflare rebinds its HTTP server on
`setOptions` — which every hot reload calls — and comes back on a **different
port**. Caching the address at startup looks correct until the first reload and
then hands out a dead one for the rest of the session. Nothing else notices,
because everything else reaches a worker through a binding; only the thing a
browser connects to directly breaks, silently. The preset re-reads it after
every reload and logs when it moves.

**It removes Nitro's own Cloudflare dev emulation.** Nitro 2.13 ships a
`cloudflare-dev` preset that every Cloudflare preset falls back to in
development, and it starts its own Miniflare through `getPlatformProxy`. Both
running means two workerd processes, two emulators opening the same SQLite files
under `.wrangler/state`, and a `request` hook race deciding which bindings the
app actually sees. Only that plugin is removed; the `cloudflare:workers` dev
shim and the esbuild target stay.

> This must happen in `build:before`. Nitro turns the plugin list into a virtual
> module inside `getRollupConfig`, which runs immediately after — so anything
> removed at `rollup:before` has already been baked into the bundle.

**Containers hot reload too.** Editing a file in a container build context
rebuilds the image and replaces the running container, without restarting the
dev server. The old container serves throughout the build; a failed build
changes nothing; one request fails at the swap while the new container boots.

**Miniflare reuses containers by name, not by image.** It names a container
after the worker and Durable Object class, so it restarts the one it already has
rather than creating one from a newly built image — which means a rebuild alone
does nothing and you keep running old code with a fresh image unused on disk.
The preset removes mismatched containers before applying a new build id. This is
also why a container left behind by a previous dev session can serve stale code.

**Container images are tagged by content hash.** Wrangler tags local dev images
with a random UUID per session, so every restart produces a fresh copy of a
possibly multi-gigabyte image. This preset hashes the build context instead —
unchanged context, same tag, full Docker cache hit, nothing accumulating.

**Containers degrade gracefully.** No Docker, or a failed build, disables
containers with a warning and leaves everything else working. This matters more
than it sounds: `unstable_getMiniflareWorkerOptions` _asserts_ on a container
build id whenever containers are declared and enabled, so a worker whose image
could not be built must explicitly disable them or it vanishes from Miniflare
entirely.

**Dangling service bindings are dropped, not fatal.** A binding pointing at a
worker that is not in the repo would otherwise take the whole dev server down at
startup, with an error naming the binding rather than the reason.

**Bindings are re-fetched after a hot swap.** `setOptions` invalidates existing
binding handles; holding the old ones gives you a live-looking object that no
longer works.

**Rebuild after editing the preset.** `extends` loads `dist/`, so `pnpm build`
here before your app will pick up a change.

## Extending it

**`src/runtime/` is built with mkdist, not rollup.** Files there are transpiled
one-to-one rather than bundled, so an import from the runtime plugin must
resolve at runtime as a real file on disk. A module shared between the runtime
plugin and the build-time module therefore lives in `src/runtime/` — mkdist
emits it alongside and rewrites the extension, while rollup inlines it into the
build-time bundle. Putting it anywhere else produces a plugin that imports a
file which was never emitted, and every request fails with "Cannot find module".

Bindings are copied from wrangler's shape into Miniflare's by an explicit list
(`BINDING_KEYS` in the runtime plugin). Durable Objects, service bindings, D1,
R2, KV, vars and the container engine are handled because that is what the
example app needed. Queues, Workflows or Hyperdrive would each be an entry in
that list plus a check that Miniflare emulates them.

Vectorize is the interesting exception: Miniflare has **no local emulator** for
it — the binding is a wrapper around a remote proxy, so it talks to a real index
in a real account. Adding it to `BINDING_KEYS` would work and would also mean
`nuxt dev` no longer runs without credentials, which is the opposite of what
this preset is for. Worth knowing before you reach for it.

## License

Dual licensed under [Apache-2.0](../../LICENSE-APACHE) or
[MIT](../../LICENSE-MIT), at your option.
