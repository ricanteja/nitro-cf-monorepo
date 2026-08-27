# nitro-cf-monorepo

A Nuxt app and its sibling Cloudflare Workers — a Durable Object and a
container — developed together in **one Miniflare instance**, and deployed to a
**throwaway per-PR environment** with its own D1 database, R2 bucket and
workers, torn down when the pull request closes.

Two pieces do the work, and they are the reason this repository exists:

- **[`packages/cloudflare-monorepo`](packages/cloudflare-monorepo)** — a Nitro
  preset that loads every worker in the repo into a single Miniflare instance,
  so cross-script Durable Object bindings, service bindings, D1, R2 and
  containers all resolve in `nuxt dev` exactly as they do in production.
- **[`.github/workflows`](.github/workflows)** — a pipeline that builds a
  complete, isolated preview environment for every pull request and destroys it
  afterwards.

Everything else is a demo app — **Skein**, a board where you pin photographs and
documents and the app shows you what connects them. The container reads the text
out of the documents and finds the faces in the photographs; naming one face
finds that person in every other photograph on the board and draws a string
between them. Several people can work on the same board at once, and you can
watch each other's cursors and drags as they happen.

It is not a product and is not trying to become one. There are no accounts, and
a board is a URL you know.

![Eight photographs pinned to a board, each with a green box drawn over a
detected face and a name beneath it. Marie Curie, Albert Einstein and Grace
Hopper each appear in two different photographs and are labelled in both. A
panel on the right lists everything on the board and groups it by person, with a
count beside each name.](skein.png)

Four of those names were typed. The other three were worked out — that board is
what [`pnpm seed`](#seeing-it-work-without-doing-anything) produces, and it
names each person **once** and lets matching find their second photograph. The
card the outline calls only "photograph" is the press photo it could not place,
which is in the seed on purpose.

> **Why a demo app at all?** Because infrastructure that has never carried a
> real binding is infrastructure you cannot trust. Every Cloudflare primitive
> here is load-bearing for a feature you can click on, which is what makes the
> local-vs-deployed parity claim meaningful instead of theoretical.

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The preset](#the-preset)
- [CI/CD and preview environments](#cicd-and-preview-environments)
- [Deploying your own fork](#deploying-your-own-fork)
- [Protecting preview URLs](#protecting-preview-urls)
- [Running this as a public repository](#running-this-as-a-public-repository)
- [Design notes](#design-notes)
- [What this deliberately does not do](#what-this-deliberately-does-not-do)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Quick start

**Prerequisites:** Node 24 (see `.nvmrc`), pnpm 10.28+, and — optionally —
Docker.

```bash
pnpm install
pnpm --filter nitro-cloudflare-monorepo build   # the preset is loaded from dist/
pnpm db:migrate                                 # create the local D1 schema
pnpm dev                                        # http://localhost:3000
```

The first visit makes a board and opens it. Afterwards `/` shows the library of
boards you already have.

### The whole thing in a hundred seconds

[![Two browser windows side by side on the same board. Both show the same two
photographs of Albert Einstein, each with a green box over the detected face
labelled with his name, and a red dashed line drawn between the two cards. A
toast reads "Found Albert Einstein in 1 other photograph(s)". One window shows
the other person's cursor, and a note reading "Pretty smart guy" appears in
both.](skein-demo-poster.jpg)](skein-demo.mp4)

**[Watch the recording](skein-demo.mp4)** — a hundred silent seconds of notes,
uploads, face matching, strings, the outline, search, and two windows editing
the same board at once.

That still is a single frame of it, and it is most of the pitch: name one face
and the other photograph labels itself, the string between them is derived
rather than drawn, and both windows are watching the same Durable Object.

### Seeing it work without doing anything

With the dev server already running, in another terminal:

```bash
pnpm seed
```

It needs **Docker** (face detection is the container's job) and network access
(it fetches the photographs). It refuses to run rather than half-work if the
bindings are not healthy, and says which one is the problem. Point it somewhere
else with `SKEIN_URL=https://… pnpm seed`.

That fetches seven public-domain portraits from Wikimedia Commons — two each of
three people, plus one person who appears only once — imports them, names each
person **once by hand**, and then imports the second photographs and checks that
nobody had to name those:

```
3. the second photograph of each — nobody names these
   Marie_Curie_(Nobel-Chem).png                    ->  recognised Marie Curie
   Einstein_1921_by_F_Schmutzer_-_restoration.jpg  ->  recognised Albert Einstein
   Grace_Hopper.jpg                                ->  recognised Grace Hopper

8 cards, 9 faces detected, 7 identified, 3 string(s) derived
3/3 second photographs recognised without being named
```

It exits non-zero if an expected match is missed, so it doubles as an
end-to-end test of the container, D1, the embeddings and the derived strings.
The photographs are **not** committed to the repository; the script fetches
them. It also imports one deliberately hard photograph — four small, angled
faces in a press photo — that is _not_ expected to match, because a board of
clean studio portraits would misrepresent what this does.

### Or by hand

- Add a **note** and double-click it to write. **Enter** saves and closes it,
  **Shift+Enter** starts a new line, **Escape** throws the edit away. Drag it,
  or grab its corner to resize and the top-left handle to rotate.
- Upload a **document** and search for a word that only appears inside it. The
  container ran OCR on it; the search box queries an FTS5 index over both typed
  notes and extracted text.
- Upload two **photographs of the same person**, click the box drawn over one
  face and give them a name. The other photograph is labelled without being
  touched, and a **string** appears between the two cards.
- Hit **String** to draw a link between any two cards by hand, in any colour.
- Open the same board URL in a second window and watch the cursors, the drags
  and the edits arrive in both. Type into a note in one and the other shows the
  words appearing, with a badge naming who is writing them.

Each of those exercises a different piece: a note is D1, an upload goes through
the container to R2, an import has the _container_ fetch the URL, dragging goes
through the Durable Object, search goes through D1's full-text index, and face
matching is a cosine comparison over embeddings stored as D1 blobs.

To check the plumbing directly, open `http://localhost:3000/api/health`:

```json
{
    "bindings": ["BOARD", "DB", "IMGMAN", "R2"],
    "checks": {
        "d1": "ok — 1 board(s)",
        "r2": "ok — read back \"ok\"",
        "durable object": "ok — reachable, 0 row(s)",
        "container": "ok — 6 native tool(s)"
    },
    "healthy": true
}
```

Those four bindings are the whole surface. There is nothing environment-specific
in that list, because there is nothing environment-specific about how anything is
reached: exactly one worker is addressable from outside, and everything else —
including the browser's WebSocket — arrives through a binding.

All four bindings are exercised for real — a query, an R2 write/read/delete, a
Durable Object round trip, and a container that reports each native tool by
_running_ it. That includes the two that cost something to reach: a Durable
Object is woken and a container is started. Checking only the cheap two was the
version of this that could report "healthy" on a board unable to accept a single
photograph.

> **Docker is optional.** Without it the preset logs a warning, disables
> containers and leaves everything else running. You lose uploads, imports, OCR
> and face detection; notes, tables, stickers, strings, sharing, live editing,
> D1, R2 and the Durable Object all still work. This is deliberate: a
> contributor fixing a CSS bug should not need a container toolchain.

### Checking the production build locally

`pnpm dev` runs the app on Node with the preset's Miniflare behind it.
To run the **built** app on workerd instead, the way it is deployed:

```bash
pnpm build
pnpm --filter skein-web preview     # http://localhost:8787
```

That is `wrangler dev` across all three configs at once — the preset rewrites
Nitro's preview command to span them, so the topology matches. D1, R2, the
Durable Object and the container all work, and `pnpm seed` runs against it with
`SKEIN_URL=http://localhost:8787`.

**Live collaboration does not work here**, and that is expected: `wrangler dev`
serves the app but gives the auxiliary workers no address of their own, so there
is nothing for a browser to open a socket to. `/api/boards/:id/socket` reports
`{"url": null, "mode": "unavailable"}` and the board behaves as a single-player
one. Use `pnpm dev` to exercise collaboration and `preview` to check the build.

### Layout

```
packages/cloudflare-monorepo/   the Nitro preset
web/                            Nuxt app (D1 + R2 + bindings to both services)
  app/stores/board.ts           one copy of board state, and the undo history
  app/utils/gesture.ts          a drag described as a function of the pointer
  migrations/                   D1 schema, FTS5 search index, face embeddings
  scripts/seed.ts               the demonstration above
  server/utils/faces.ts         embedding storage and the similarity search
  shared/utils/                 auto-imported into BOTH browser and server
services/board/                 Durable Object — live layout, presence, alarms
services/imgman/                Container — native image work
  container/                    the image: ImageMagick, libheif, poppler,
                                tesseract (OCR), OpenCV + YuNet + SFace (faces)
scripts/wrangler-env.sh         placeholder substitution for deploys
.github/workflows/              the pipeline
```

---

## Architecture

Three deployable workers. Each exists because something genuinely cannot be
done by the layer above it.

| Worker   | Kind            | Why it is not just part of `web`                                                                                                                       |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web`    | Nuxt on Workers | The only public entry point: UI, REST, orchestration                                                                                                   |
| `board`  | Durable Object  | One authoritative coordination point per board. D1 has no pub/sub and cannot serialise concurrent edits                                                |
| `imgman` | Container       | Native codecs (libheif, poppler), OCR (tesseract), face detection and recognition (OpenCV), and the only place a resolved-IP-checked fetch is possible |

### Bindings

| From     | To       | Kind                            |
| -------- | -------- | ------------------------------- |
| `web`    | D1, R2   | storage                         |
| `web`    | `board`  | **cross-script** Durable Object |
| `web`    | `imgman` | service                         |
| `board`  | D1       | storage (write-behind)          |
| `imgman` | R2       | storage                         |

That set is chosen on purpose: it is the collection of bindings that behaves
differently in local development than in production unless something makes them
agree. Making them agree is the preset's whole job.

**Nothing reads `event.context.cloudflare.env` directly.** Server code goes
through `useCloudflare(event)` in `web/server/utils/cloudflare.ts`, which is
worth one paragraph because the reason is not obvious. That context property is
the documented place bindings live, and in `nuxt dev` it holds them — the preset
puts them there. In a **deployed** worker it is empty. nitropack's
cloudflare-module handler passes the platform context to `localFetch` under
`_platform`, and h3 copies it onto `event.context` only when it finds it at
`event.node.req.__unenv__`, which nitropack 2.13.4 does not set on that path.
The bindings are still reachable — the same handler assigns them to a global
first — so the accessor prefers the documented location and falls back to the
global. One accessor also means the failure is one 503 that names every missing
binding, rather than a `TypeError` in whichever handler dereferenced one.

**The browser's WebSocket goes through a binding too, which is the part worth
reading twice.** It arrives at `web`, on the app's own origin, at
`/api/boards/:id/socket`. The preset hands it to
[`web/server/upgrade.ts`](web/server/upgrade.ts) _above_ Nitro, which passes it
to the Durable Object through the same `BOARD` binding every server-side call
uses. The 101 comes back untouched.

That has to happen above Nitro, and the reason is worth stating because getting
it wrong costs a lot: Nitro rebuilds every handler's return value into a fresh
`Response`, and `new Response(null, { status: 101 })` throws. So an upgrade can
never be answered from a route. It can be answered from the worker entry, which
is upstream of all of that — see [The preset](#the-preset).

**Exactly one worker is reachable from outside: `web`.** `board` and `imgman`
are `workers_dev: false` with no routes in every environment. There is no second
hostname to compose at deploy time, no second certificate, nothing extra to tear
down, and one place to put an access policy. `board` still authenticates
nothing — a board is a URL you know, and the role a socket asks for is
client-supplied — but it is now behind whatever protects the app, instead of
beside it.

### The vocabulary

Six nouns, and nothing else is invented anywhere in the codebase. Worth knowing
before reading any of it:

| Noun       | What it is                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| **board**  | The thing you open. Holds everything else                                     |
| **card**   | A note, an image, or a sticker. The only thing you drag                       |
| **grid**   | A table under the cards — a tier list, a kanban, a plain grid                 |
| **link**   | A string between two cards. Drawn by hand, or derived from a shared person    |
| **person** | A name, scoped to one board                                                   |
| **face**   | A rectangle found in an image, its 128-float embedding, and possibly a person |

Layering is _derived_ from a card's kind — grids underneath, notes and images
above them, stickers on top — rather than stored, so the two cannot disagree.

### Who owns what

Three stores hold pieces of a board, and knowing which one is authoritative for
which fact is most of understanding this codebase.

| Fact                                             | Authoritative store                     |
| ------------------------------------------------ | --------------------------------------- |
| A card exists; its text, colour, size, image key | **D1**                                  |
| Where a card sits right now                      | **The Durable Object**, while connected |
| Where a card sits at rest                        | D1, as of the last flush                |
| The bytes of a photograph                        | **R2**, owned by the board              |
| What a face looks like (128 floats)              | D1, as a blob on the face               |
| Your undo history                                | **The browser**, per session            |

The read path has to agree with the write path, or the result is a class of bug
that looks like the interface losing its mind: reading a board straight out of
D1 while the Durable Object holds unflushed positions makes cards jump back to
where they were a few seconds ago. Every read of layout — loading a board,
copying a card, snapshotting one for undo — goes through `liveLayout()` in
[`server/utils/cards.ts`](web/server/utils/cards.ts), which overlays the object's
live state on the table.

### Data flow

**Add something to the board.** Browser → `web` → `imgman` over a service
binding. The container decodes it (HEIC and PDF included), normalises
orientation, strips EXIF, resamples a thumbnail, runs OCR over it, finds the
faces and turns each one into 128 numbers. The Worker writes original and
thumbnail to R2 under `boards/<board id>/…`; `web` stores the row, the extracted
text, the face boxes and their embeddings in D1, matches each new face against
the ones already named on that board, and tells the `board` DO to pick it up.

For a URL import the container also does the _fetching_ — it resolves the
hostname, refuses private addresses, and re-validates every redirect hop, none
of which a Worker can do because it never sees a resolved address.

**Find something.** A D1 trigger keeps an FTS5 index in step with both a note's
typed text and a document's extracted text, so one query searches the things you
wrote and the things you photographed.

**Recognise someone.** Faces carry a 128-float embedding, stored as a D1 blob.
Naming one face searches every other face on the board by cosine similarity and
labels the ones that clear the threshold; importing a new photograph searches
the other way, against the people already named. Both are a linear scan — see
[Design notes](#embeddings-live-in-d1-not-in-a-vector-database).

**Connect two things.** Any two cards sharing a person are joined by a string.
Those strings are _derived at read time_ rather than stored, so naming, renaming
or clearing a face makes them appear and disappear with nothing to recompute.
Strings you draw by hand are stored, coloured and cuttable.

**Type into a note, with other people watching.** Keystrokes are relayed
through the Durable Object and never stored there. An unfinished sentence is not
a fact about the board — it is a fact about a person, it stops being true the
moment they stop typing, and storing it would mean deciding what to do with the
half-sentence somebody abandoned when their laptop closed. The saved value
arrives separately, through D1, like every other content change.

**Move something, with other people watching.** The browser announces the
gesture once — what is being dragged, and where in it you took hold — and then
says nothing more until you let go. Everyone else already receives your pointer
at 25 updates a second, and that is enough to place the card: they run the same
function you do. On release, one settled move goes to the `board` DO, which
records it, broadcasts it and schedules a flush. On the alarm it writes dirty
rows to D1 in one batch.

> **Why the DO owns layout at all.** D1 is the source of truth at rest; the DO
> is the source of truth while a session is open. Dragging a card produces a
> burst of updates, and every one of them would otherwise be a database write.

## The preset

`nuxt dev` runs on Node. Your deployed app runs on workerd. Bindings are the
seam where that difference shows, and the preset's job is to make the seam
invisible. It does five separable things:

**1. Bundles auxiliary workers** ([`src/dev.ts`](packages/cloudflare-monorepo/src/dev.ts)).
Reads each sibling worker's own `wrangler.jsonc`, bundles its entry point with
esbuild, and hands the result to Miniflare.

**2. Builds container images** (same file). Cloudflare's dev tooling tags local
container images with a **random UUID per dev session**, which means a fresh
copy of a multi-gigabyte image every time you restart. This preset hashes the
build context instead, so an unchanged context produces the same tag and Docker
gets a cache hit.

> A random tag per session means every restart is a cache miss and a new image
> on disk. Across a few weeks of development that is tens of gigabytes of
> near-identical layers. See [Troubleshooting](#troubleshooting) for reclaiming
> space that other tools have already left behind.

**3. Runs one Miniflare instance for everything**
([`src/runtime/plugin.dev.ts`](packages/cloudflare-monorepo/src/runtime/plugin.dev.ts)).
A stub "main" worker carries the Nuxt app's bindings, every auxiliary worker
joins the same instance, and a request hook injects
`event.context.cloudflare.env`. Auxiliary workers are re-bundled and hot-swapped
on change.

**4. Answers WebSocket upgrades above Nitro, so a browser never needs a second
hostname.** A browser cannot hold a binding, so anything it talks to must be
reachable over HTTP — and the obvious way to satisfy that, giving the Durable
Object's worker a hostname of its own, buys a second public surface and an
authentication story that has to be told twice.

It is not necessary. Nitro rebuilds every _handler's_ return value into a fresh
`Response`, and `new Response(null, { status: 101 })` throws, so an upgrade
cannot be answered from a route. The worker _entry_ is upstream of that: what it
returns is what the runtime sends. The preset replaces the entry with one that
calls the app's own `upgrade` module first
([`runtime/entry.prod.ts`](packages/cloudflare-monorepo/src/runtime/entry.prod.ts)),
and bundles the same module into Miniflare's main worker for development, where
Nitro serves HTTP from Node and Node cannot return a workerd socket.

One module, one binding, both environments. The app declares it in one line:

```ts
nitro: {
    cloudflareMonorepo: {
        upgrade: './server/upgrade.ts'
    }
}
```

Live cursors and multi-user editing exist in this repo because that one branch
does, and `board` has no hostname because of it.

**5. Replaces Nitro's own Cloudflare dev emulation.** Nitro 2.13 ships a
`cloudflare-dev` preset that every Cloudflare preset falls back to in
development, and it starts a Miniflare instance of its own through
`getPlatformProxy`. Leaving both in place means two workerd processes, two
emulators opening the same SQLite files under `.wrangler/state`, and a request
hook race deciding which set of bindings the app actually sees. The preset
removes that plugin — only the plugin; the `cloudflare:workers` dev shim and the
esbuild target are still wanted.

> This has to happen in `build:before`. Nitro turns the plugin list into a
> virtual module inside `getRollupConfig`, which runs immediately afterwards, so
> anything removed at `rollup:before` has already been baked into the bundle.

### Hot reload, including containers

Editing an auxiliary worker's source re-bundles it and hot-swaps it into the
running Miniflare instance. Editing the code **inside a container** does the
same thing, the slow way: rebuild the image, replace the container, carry on.
Neither needs the dev server restarted.

The container path exists because two things otherwise conspire to serve you
stale code. Nothing watches a build context by default, and — more subtly —
**Miniflare names containers after the worker and Durable Object class, not
after the image**, so it restarts the container it already has rather than
creating one from your new image. A rebuild with no replacement is a rebuild
that does nothing. The preset removes containers whose image no longer matches
before handing Miniflare the new build id.

What that costs you, measured against a request every half second:

| Phase                  | Behaviour                                                                      |
| ---------------------- | ------------------------------------------------------------------------------ |
| While the image builds | The old container keeps serving. Nothing is torn down until the build succeeds |
| At the swap            | One request fails while the new container boots                                |
| If the build fails     | Nothing is touched. The old container keeps serving and the error is logged    |

That single failed request is deliberate rather than solved: removing the gap
would mean running two containers and cutting over between them, which is a lot
of machinery for a dev loop where you have just saved a file and are expecting
a reload anyway.

> The build id is a hash of the build context, so it doubles as the change
> detector — an edit that changes nothing costs one cached `docker build` and
> stops there. It hashes paths, sizes and mtimes rather than file contents,
> because it runs on every keystroke-triggered save and a build context can be
> hundreds of megabytes. One consequence: reverting a file produces a _new_ tag,
> since its mtime changed.

### Using it

```ts
// nuxt.config.ts
nitro: {
    preset: 'cloudflare-module',
    extends: ['nitro-cloudflare-monorepo'],
    cloudflareMonorepo: {
        workers: [
            { configPath: '../services/board/wrangler.jsonc' },
            { configPath: '../services/imgman/wrangler.jsonc' },
        ],
        // Optional. Answers WebSocket upgrades above Nitro, in both
        // environments, so no auxiliary worker needs a hostname.
        upgrade: './server/upgrade.ts',
    },
}
```

> **Why both `preset` and `extends`?** This is not redundancy. Nitro resolves
> presets through an internal registry _before_ it loads external packages, so
> in dev an external preset is silently ignored and replaced with `nitro-dev`.
> `preset` must therefore name a built-in for the production build to come out
> right, while `extends` is what actually loads the dev module. If Nitro ever
> supports external presets properly, this collapses to one line.

### Things it handles that will otherwise bite you

- **`serviceBindings` vanish in dev.** A `services` entry deploys correctly but
  is simply absent from `event.context.cloudflare.env` locally unless it is
  copied into Miniflare's worker options. The logs look fine; the binding is
  just missing.
- **Bindings are poisoned after `setOptions`.** Hot-swapping a worker
  invalidates existing binding handles; they must be re-fetched.
- **`unstable_getMiniflareWorkerOptions` asserts on a container build id**
  whenever containers are declared and enabled. A worker whose image could not
  be built must explicitly disable containers, or it disappears from Miniflare
  entirely.
- **A service binding to a worker outside the repo is fatal at startup**, and
  the error names the binding rather than the reason. Those are dropped with a
  warning instead.
- **Miniflare moves.** It rebinds its HTTP server when options change — which
  is what every hot reload does — and comes back on a different port. Reading
  the address once at startup looked correct for as long as nothing reloaded,
  and then handed out a dead one for the rest of the session. Everything kept
  working, because everything _else_ reaches a worker through a binding; the one
  thing a browser connects to directly, the WebSocket, silently stopped. The
  origin is now re-read after every reload.

> **Expanding this:** the preset supports containers, Durable Objects, D1, R2,
> KV and service bindings because those are what this repo needed. Queues,
> Workflows, Hyperdrive and Vectorize would each be a line in `BINDING_KEYS` in
> the runtime plugin plus a check that Miniflare emulates them.

---

## CI/CD and preview environments

```
pull_request ──► detect changes ──► quality (per project, parallel)
                                        │
                                        ▼
                                   quality gate
                                        │
                                        ▼
                    resources ──► board + imgman ──► web ──► PR comment
pull_request closed ──────────────────► cleanup (reverse order)

push to main ──► detect changes ──► board + imgman ──► web
```

![A comment posted by the workflow on a pull request, headed "Preview
environment". It gives the preview URL, then a table of the five resources
created for it — three workers, a D1 database and an R2 bucket — with a column
saying which of them is reachable: the URL for web, "binding only" for board and
imgman. Below the table, a line saying everything above is destroyed when the
pull request closes.](skein-comment.png)

Every pull request gets that comment, updated in place rather than appended, so
a branch with twenty pushes has one comment showing the current state instead of
twenty stale ones.

**Quality is per project. Previews are per environment.** Quality checks are
independent and fast feedback matters, so they run separately and in parallel.
A preview cannot be partial: `web` names `board` in a `script_name` and reaches
`imgman` over a service binding, and Cloudflare rejects a deploy whose
`script_name` does not already exist (error `[10061]`). So the whole environment
deploys as one unit, ordered, and tears down in reverse.

### Resource naming

Every deployed resource is named from **one value**: `cloudflare.resourcePrefix`
in the root [`package.json`](package.json). A fork changes it once.

It is **lowercased and validated** when CI reads it, because it is not only a
name — with a production zone configured it becomes a DNS label in
`<prefix>.example.com`. `Skein` is accepted and becomes `skein`, with a
notice saying so; anything that cannot be a hostname is rejected there, in the
first seconds of the run, rather than several minutes later when Cloudflare
refuses the custom domain.

```
ws-<prefix>-web-pr-42        ws-<prefix>-web-prod
ws-<prefix>-board-pr-42      ws-<prefix>-board-prod
ws-<prefix>-imgman-pr-42     ws-<prefix>-imgman-prod
ws-<prefix>-imgman-pr-42-image
                             ws-<prefix>-imgman-prod-image   (container image)
d1-<prefix>-pr-42            d1-<prefix>-prod
r2-<prefix>-pr-42            r2-<prefix>-prod
```

Wrangler configs have no variable interpolation, so deployed names are written
as `[[PREFIX]]`, `[[PR_NUM]]`, `[[D1_ID]]` and `[[ZONE]]`, and filled in by
[`scripts/wrangler-env.sh`](scripts/wrangler-env.sh) at deploy time.

**The table above is a description, not a specification.** The wrangler configs
are where those names are actually declared, and CI reads them back out rather
than rebuilding them: before it creates a database or a bucket it substitutes
the placeholders into a throwaway copy and asks
[`scripts/resource-name.mjs`](scripts/resource-name.mjs) what the resource is
called, which parses it with wrangler's own `unstable_readConfig` — the same
reader the deploy uses, so environment inheritance and JSONC resolve exactly as
they will at deploy time.

That matters because the alternative is two copies of one convention. CI needs
the name before the resource exists, and it used to rebuild the string in shell
next to a config that declared it independently. Change the convention in the
config alone and CI would have provisioned resources the worker does not bind —
a mismatch that shows up as a failed deploy at best, and as a worker bound to
the wrong database at worst. Now there is one place to change it.

Only `web` has a hostname, so `[[ZONE]]` appears only in
[`web/wrangler.jsonc`](web/wrangler.jsonc). The custom-domain block sits between
`/*<zone*/` and `/*zone>*/` markers, and the script either keeps it or deletes
the whole range, leaving wrangler's `workers.dev` default. The markers delimit a
**range** rather than tagging each line because prettier reflows a long `routes`
entry across several lines, and a per-line marker would survive formatting only
until someone ran it.

> **Why local development needs none of this.** Placeholders appear _only_
> inside `env:` blocks. The top level of every wrangler config is real,
> prefix-free, local configuration — Miniflare's D1 and R2 live in
> `.wrangler/state` and cannot collide with anything in a real account, so they
> need no uniqueness. `pnpm dev` therefore runs against these files untouched,
> with no preprocessing step and nothing to keep in sync.

> **The substitution script fails loudly on anything left over.** Without that
> check, a forgotten placeholder deploys a worker bound to a database literally
> named `[[D1_ID]]`, which fails much later and much less obviously.

### Container images are the thing that quietly accumulates

Deleting a Worker does **not** delete the container images it pushed, and image
storage is capped at **50 GB per account** — shared with every other project in
it. A repository opening a few dozen pull requests against a container this size
will reach that cap, and the failure appears as a deploy that cannot push rather
than as anything mentioning storage.

**A container application is a third resource again**, distinct from both, and
it is the one that bites rather than merely accumulating. It survives with live
instances attached and pins the Durable Object namespace it was created
against, so the failure is a later deploy refusing with _"there is already an
application with the name … associated with a different durable object
namespace"_ — which only happens once a pull request number is reused. A
repository can carry these for months and only discover them when it restarts
at PR 1.

Teardown therefore removes the PR's container application and its images as
well as its workers, buckets and database. That step is best-effort: `wrangler containers images list` prints for
humans, and its format is not a contract — it once matched `name:tag` against a
listing that is actually whitespace-separated columns, found nothing, and
reported success while eight image tags accumulated. It echoes the raw listing before
parsing anything out of it, so a changed format shows up in the log rather than
silently matching nothing.

**Teardown touches no DNS at all.** Previews publish on `workers.dev`, so a
preview never owns a Custom Domain, a certificate or a DNS record — only
production does, and production is not torn down. That is one of the quieter
benefits of the split: nothing in the destructive path can strand a DNS record
pointing at a worker that no longer exists.

### Deployed names are explicit

Each environment sets its own `name` rather than relying on wrangler appending
the environment to the top-level name. Two extra lines, and the deployed name
can be read straight off the file instead of reconstructed in your head.

---

## Deploying your own fork

Four steps and a check: find your account id, make a token, fill in one block of
`package.json`, and add the token and the account id to the repository.

### 1. Find your account id

```bash
npx wrangler login
npx wrangler whoami          # prints your account id
```

Keep it for step 4. You do not need to look up your `workers.dev` subdomain — CI
reads that from the account — but you do need to have one, so if you have never
deployed a Worker, Cloudflare will ask you to choose it the first time.

### 2. Create the Cloudflare API token

**Dashboard → My Profile → API Tokens → Create Token → Create Custom Token.**
Give it these permissions:

| Scope                   | Permission         | Level | Needed for                   |
| ----------------------- | ------------------ | ----- | ---------------------------- |
| Account                 | Workers Scripts    | Edit  | always                       |
| Account                 | D1                 | Edit  | always                       |
| Account                 | Workers R2 Storage | Edit  | always                       |
| Account                 | Workers Containers | Edit  | the image container          |
| Zone — _your zone only_ | Workers Routes     | Edit  | only with a `productionZone` |

Under **Account Resources** pick the one account. Then copy the token — it is
shown once.

**The zone permission is separate, and it is the one that fails late.** Adding a
Custom Domain writes a worker route, which is a zone-scoped operation: a token
without it uploads the worker successfully and _then_ fails on
`/zones/{id}/workers/routes` with `code: 10000`, leaving a deployed preview with
no hostname and an error that reads like a broken deploy. Both workflows probe
that exact endpoint before building anything, so it now fails in about a second
with a message naming the permission.

Only needed if you set `cloudflare.productionZone` in step 3. Set it under
**Zone Resources → Include → Specific zone → your zone**, not all zones. This token lives in CI, and the account holding it may well have
production zones on it that no preview should be able to touch. Granting
`Workers Routes` on the zone is enough on its own — it also makes the zone
visible to the token, so no separate `Zone · Read` is needed.

> **The dashboard and the API name these differently, which costs people an
> afternoon.** The permission picker says **Edit**; the API, and any list of a
> token's permissions, says **Write** — so `D1 Write` in a token's policy _is_
> `D1: Edit` in the dashboard, and seeing `D1 Read` and `D1 Write` both listed
> does not mean the token is read-only. Do not go hunting for a permission
> called "Edit" in an API response.

> An account-owned token — **Manage Account → Account API Tokens** rather than
> **My Profile** — is usually the better choice for CI. It belongs to the
> account rather than to you, so it keeps working if your user is removed. Both
> kinds work here.

> A probe proves the permission exists, not that it is set to **Edit**. If
> reads pass and creation is still refused with `10000`, the permission is
> there at Read level.

Containers additionally require Containers to be enabled on the account, which
is separate from the token permission. If a deploy is rejected the workflows
surface the Cloudflare error code: `9109` and `10000` mean the token is wrong or
under-scoped, `10429` means you have hit the account-wide R2 rate limit (wait,
then re-run).

### 3. Fill in `package.json`

One block, in the root [`package.json`](package.json):

```jsonc
"cloudflare": {
    "resourcePrefix": "yourname",        // every resource name is built from this
    "productionZone": "example.com"      // optional; see below
}
```

**`resourcePrefix`** — change it so your resources do not collide with anyone
else's. Use lowercase letters, digits and dashes, not starting or ending with a
dash: with a production zone set it becomes a DNS label in
`yourname.example.com`. CI lowercases it for you and says so, and rejects
anything that cannot be a hostname in the first seconds of a run rather than
minutes later when Cloudflare refuses the custom domain.

**`productionZone`** — optional, and the only setting that changes where things
are published:

| Set to a zone you own  | Left out                                       |
| ---------------------- | ---------------------------------------------- |
| `yourname.example.com` | `ws-yourname-web-prod.<subdomain>.workers.dev` |

Previews are unaffected either way — they always publish on `workers.dev`, for
the reason in
[Previews on workers.dev, production on a domain you own](#previews-on-workersdev-production-on-a-domain-you-own).
The zone must be **already active on the same account**, and the hostname must
not already have a CNAME record. Leave it out and no zone permission is needed
on the token at all.

### 4. Add the secret and the account id

**Settings → Secrets and variables → Actions.**

| Tab       | Name                    | Where it came from |
| --------- | ----------------------- | ------------------ |
| Secrets   | `CLOUDFLARE_API_TOKEN`  | step 2             |
| Variables | `CLOUDFLARE_ACCOUNT_ID` | step 1             |

**The account id is here rather than in `package.json`, deliberately.** It is
not a password — it appears in every R2 endpoint and dashboard URL — but it is
half of what an attacker needs. A token that leaks is far more useful to
somebody who already knows which account to spend it against, and a public
repository is the easiest place in the world to find that out. Keeping the two
halves apart costs one settings field.

Nothing else is asked for. Everything else is either in `package.json`, where a
change to it shows up in a pull request diff, or worked out at run time:

- **Resource names** come from the wrangler configs, read back with wrangler's
  own parser, so the naming convention lives in exactly one place.
- **The production database id** is looked up by the name in that config, and
  the database is created if it is not there. It used to be a variable holding a
  uuid that had to stay in agreement with a name written elsewhere. It did not:
  the variable pointed at `db-<prefix>-prod` while the config bound
  `d1-<prefix>-prod`.
- **Your `workers.dev` subdomain** is read from
  `/accounts/{id}/workers/subdomain`. It used to be a variable too, and was once
  set to the resource prefix, so every pull request advertised a preview link to
  a host that did not exist.

`GITHUB_TOKEN` is provided by Actions automatically — you do not create it.

### 5. Production resources — nothing to do

The first deploy to `main` creates `d1-<prefix>-prod` and `r2-<prefix>-prod` if
they are not already there, and reuses them on every deploy after. Per-PR
resources work the same way.

This was once a manual step, on the reasoning that CI able to conjure production
storage is CI able to conjure a second copy of it quietly. That did not survive
the observation that the preview workflow already creates a database and a
bucket on every pull request — the capability was identical, and all the manual
step added was a variable that could disagree with the config.

Both steps are create-or-**reuse**, and nothing in this pipeline deletes
production storage.

> Already have a production database under a different name? Change what the
> config asks for — `database_name` in the `prod` block of
> [`web/wrangler.jsonc`](web/wrangler.jsonc). That block is the only place the
> name is written down, and deploy reads it from there.

### Check it worked

Open a pull request. Within a few minutes you should get a comment listing the
preview URL and the five resources created for it — three workers, a database
and a bucket. If the run fails at
**Check credentials**, a variable or secret above is missing or misspelled —
that step names which one.

Merging to `main` deploys to production, creating its database and bucket on
the first run.

---

## Protecting preview URLs

**Preview URLs are public by default**, and so is production. Anyone who knows
the hostname can open it, which for a demo board is fine and for anything real
is not.

This repository does **not** automate the protection, deliberately — the policy
belongs to your account rather than to a repo you forked. Configure it once, in
the Cloudflare dashboard:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Set the application domain to cover your preview hostnames
3. Add a policy — _Allow_, with an _Emails ending in_ rule for your domain, or
   a specific list of addresses
4. Save

**Use `*.<subdomain>.workers.dev` as the application domain.** Previews always
publish there, so one wildcard covers every preview this repository will ever
open — including pull requests nobody has raised yet, which is the whole reason
previews are not on a custom domain. A Custom Domain matches a hostname exactly
and accepts no wildcards, so a zone-based preview would need a policy naming
each hostname as it appeared, and a policy that covers nothing looks exactly
like a policy that works.

The cost of that wildcard is worth knowing: it protects **every** Worker on the
account that publishes to `workers.dev`, not only this repository's. On an
account shared with other projects, check what else that catches.

**Production is a separate hostname** — `<prefix>.<zone>` — and therefore a
separate decision. Protect it, or leave it open, independently of previews.

Confirm it covers what you think, without opening a browser — a protected
hostname redirects rather than answering:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<your-preview-host>/
```

`302` to `*.cloudflareaccess.com` means protected. Anything else means open.

Every preview then inherits the policy automatically, including previews for
pull requests opened later. Nothing in the pipeline changes.

![A Cloudflare Access sign-in page for a preview hostname, asking for an email
address to continue.](access.png)

That is what anyone reaching a preview URL sees before the app loads.

### Access and the WebSocket

**It just works, and that is the point.** The socket is opened to the app's own
origin, so the cookie the page already holds covers it. There is one hostname,
one application, one policy.

That is worth calling out because the obvious alternative does not work. Give
the Durable Object's worker its own hostname and the browser opens the socket to
a hostname it has no Access cookie for; Access answers `302` to a login page; a
WebSocket upgrade cannot follow a redirect. The socket fails, the board looks
completely normal, and nothing ever arrives from anyone else. The only fixes are
to exclude that hostname from the policy — leaving the socket unprotected while
the app is protected — or to stop having a second hostname. This repository does
the latter; see [Bindings](#bindings).

To check that a policy covers what you think it does, an Access-protected
hostname redirects rather than answering:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<your-preview-host>/
```

---

## Running this as a public repository

**Will making this repository public leak my Cloudflare credentials?** No — not
unless a workflow you write prints them.

GitHub never exposes repository secrets or configuration variables to the
public. They are not readable from the Settings UI without repository access,
their values cannot be read back once set, and secret values are masked in logs.
Only workflow runs can see them.

Pull requests from forks — the case that actually matters on a public repository
— get nothing. Per GitHub's documentation, _"with the exception of
`GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is
triggered from a forked repository"_, that `GITHUB_TOKEN` is read-only, and
configuration variables are withheld as well. A fork's pull request here reaches
the `Check credentials` step, finds an empty token, and stops. No preview
environment is created for outside contributors.

That holds because every workflow in this repository triggers on
**`pull_request`**, never `pull_request_target`. The distinction is the whole
security model: `pull_request` runs the pull request's own code _without_
secrets, while `pull_request_target` runs with full access to secrets even for
forks. Checking out a fork's code inside a `pull_request_target` workflow is the
most common way Actions credentials leak.

### The one thing worth knowing if you edit the workflows

On a public repository, workflow logs are readable by anyone with a GitHub
account. Secrets are masked there; **repository variables are not**, because
GitHub does not treat them as secret.

What decides whether a value reaches the log is how it reaches the script. An
expression substituted into a `run:` block is rendered into the log along with
the command:

```yaml
# The value is printed on every run.
- run: ./deploy.sh "${{ secrets.SOME_TOKEN }}"

# The value stays in the environment.
- env:
      TOKEN: ${{ secrets.SOME_TOKEN }}
  run: ./deploy.sh "$TOKEN"
```

The workflows here use the second form throughout. Masking is also defeated by
transforming a value before printing it — base64, or splitting it across lines —
so the general rule is simply not to print credentials.

### What is deliberately not secret

The resource prefix, the production zone, worker names, and database and bucket
names are all in this repository and printed in pull request comments. None of
them is a credential: knowing a bucket is called `r2-scrap-pr-42` gets you
nothing without a token.

**The account id is treated as sensitive even though it is not a password.** It
lives in a repository variable rather than in `package.json`, because a leaked
token is far more useful to somebody who already knows which account to point it
at — and a public repository is the easiest place to find that out. Variables
are not masked in logs, so it does still appear there; the point is only that it
is not published in the source tree alongside everything else. Defence in depth
costs one settings field here, which is cheap.

Preview URLs are the exception — they are reachable by anyone who knows them
unless you configure Access, which is what the previous section covers.

For your own fork, a dedicated Cloudflare account, a token scoped to the
permissions in [step 2](#2-create-the-cloudflare-api-token), and that token held
in a GitHub Environment with required reviewers are all worth the few minutes
they cost.

---

## Design notes

Decisions that are not obvious from the code, and what they cost.

### Embeddings live in D1, not in a vector database

A face carries 128 float32s — 512 bytes — describing what it looks like, stored
as a blob on the row. Matching is a cosine comparison over every named face on
the board, in the Worker.

The obvious alternative is Vectorize, and it is the wrong tool at this size.
A board holds tens of faces, so the whole set fits in one query and the
comparison is a dot product per row — tens of microseconds against a network
round trip. More decisively: **Miniflare has no local Vectorize.** The binding
proxies to the real service, so adding it would mean this repository stops
running from a clean clone without a Cloudflare account, which is the one claim
it exists to make. The scan stops being the right answer somewhere around tens
of thousands of faces, which is not a board a person is looking at.

The threshold — `0.363` — is the value SFace's authors publish for cosine
similarity, not one invented here. On the seed photographs, two portraits of the
same person score 0.42 to 0.84 and every pair of different people scores 0.27 or
below, which is why one fixed number is enough.

> D1 hands blobs back as an ArrayBuffer, a typed-array view, _or_ a plain array
> of byte values, depending on the driver. Code that assumed the first treated
> every stored embedding as absent, and nothing errored — matching just never
> found anybody. `unpackEmbedding` accepts all three.

### A drag is a function of the pointer, not a stream of positions

Broadcasting a drag as a stream of card positions means two streams saying
nearly the same thing — a cursor at 25 updates a second and a card at rather
fewer — and the card visibly lags its own cursor, because it is the slower of
the two.

Instead the gesture is announced **once**, with the few constants needed to
reconstruct it, and everyone derives the card from the pointer stream they are
already receiving. The card cannot drift from the cursor dragging it, because it
is computed from it. A one-second drag costs two gesture messages and one
settled move on top of the cursors, instead of twenty-odd position updates.

The constants are chosen so a receiver needs nothing of its own: a rotation
needs a pivot, and the pivot travels in the message rather than being measured
locally, so a client that has never laid the card out can still mirror what is
happening to it. The same `gestureLayout()` runs on the machine doing the
dragging and on every machine watching — two implementations of "how far does a
rotation go" would eventually disagree, and you would find out by noticing
somebody's card at a slightly different angle to yours.

### Undo belongs to the browser, not to the Durable Object

It lived in the object first, where it could only ever cover _moving_ things:
creating and deleting a card are D1's business, reached over the REST API, and
the object never hears about either. Ctrl+Z stepped back through your moves and
silently ignored everything else you had done, which is worse than not offering
it.

In the browser, every action passes through one place on its way out, so one
stack holds moves, creations, deletions and content edits in the order they
happened. It is per-person by construction rather than by bookkeeping, and it
survives a reconnect, which the object's version did not.

An entry is **skipped** when the world no longer looks the way it left it —
somebody else has moved the card since, or deleted it. That is what "you cannot
undo someone else's change" means in practice: rather than clobbering their
work, it declines and moves on to your previous action.

### Exactly one worker is public

`web` is reachable from the internet. `board` and `imgman` are not, in any
environment — `workers_dev: false`, no routes, no hostname to configure. The
only way in is a binding.

This is the invariant the whole layout is built on, and it survived meeting a
feature that appears to break it. Skein's board is live: the browser needs a
WebSocket to a Durable Object, and a browser cannot hold a binding. The obvious
move is to give `board` a hostname, and it is wrong. Measured, that move costs a
second public surface, a hostname composed at deploy time, a dependency on the
account-wide `workers.dev` subdomain, a certificate per pull request, an extra
teardown step, two more permissions on the CI token, and an access policy that
has to be told about both hostnames — where getting it wrong protects the app
and silently breaks the socket.

The alternative costs one branch. Nitro rebuilds every _handler's_ return value
into a fresh `Response`, so `new Response(null, { status: 101 })` throws and an
upgrade cannot be answered from a route — but the worker _entry_ is upstream of
that, and nitropack's own entry already branches on `Upgrade: websocket` in
exactly that place. The preset replaces the entry with one that calls the app's
`upgrade` module first, and gives Miniflare's main worker the same module for
development. The socket then travels the same binding as everything else.

The general form: **when the platform seems to force a second public surface,
check which layer the obstacle is really at.** Here it was Nitro's handler
layer, not the worker, and the fix was one layer up rather than one hostname
out.

### Previews on workers.dev, production on a domain you own

These pull in opposite directions and the split follows from access control, not
from taste.

A `workers.dev` subdomain belongs to the **account**: one per account, shared by
every Worker on it, and it is a wildcard you can write a single Cloudflare Access
policy against. `*.<subdomain>.workers.dev` protects every preview this
repository will ever open, including pull requests nobody has raised yet.
Custom Domains match a hostname **exactly** and accept no wildcards, so previews
on a zone would mean an Access application naming each preview hostname as it
appeared — per-PR policy creation in CI, or previews that are quietly public.
That is a lot of machinery to buy a prettier hostname for something that lives
for the length of a pull request.

Production inverts every term. It is one long-lived hostname, it is what people
see, and Cloudflare is explicit that `workers.dev` is
[treated as a Free website and not intended for business-critical use](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
So production gets a Custom Domain on a zone you own, and Cloudflare manages the
DNS record and the certificate.

The cost of the wildcard is real and worth stating: an Access policy over
`*.<subdomain>.workers.dev` covers every Worker on the account that publishes
there, not only this repository's. On a shared account, that is a thing to check
rather than assume.

There is one consequence for naming. Because the hostname _is_ the worker name,
and worker names are unique per account, every project sharing an account has to
disambiguate in the name itself — which is what `ws-<prefix>-web-pr-42` is for,
and why a preview URL is longer than it would otherwise be. Production, on its
own zone, is just `<prefix>.<zone>`.

### R2 objects belong to the board, not to the card

Deleting a card is undoable, so it must not destroy bytes — an undo that
restored a photograph as a broken image would be worse than no undo. But that
leaves images whose card is gone and nothing pointing at them, which a sweep
driven by the rows could never find.

So keys are namespaced: everything an upload writes lives under
`boards/<board id>/…`, and deleting a board lists and deletes that prefix.
A prefix is a list operation; a missing row is a leak.

### The alarm is throttled, not debounced

A Durable Object has exactly one alarm; calling `setAlarm` again _overwrites_
the pending time. Re-arming on every edit therefore pushes the flush further
out with each change, and under sustained editing it never fires at all — an
eviction then loses everything since the last quiet moment, which is precisely
the window write-behind exists to bound.

Leaving an existing alarm alone gives a hard ceiling instead: an edit reaches D1
within `FLUSH_INTERVAL_MS` no matter how much editing follows it, while a burst
inside one window still collapses to a single write.

The same write-behind creates a second trap on the way in. When a card is
created or deleted, D1 tells the room to re-read itself — and refilling
wholesale from a table that is up to one flush interval behind throws away every
unflushed position. Drag a card, add a note, and the drag was silently undone
for everybody. Re-hydration now leaves dirty rows alone: what the refresh is for
is _which cards exist_, not where the ones already here have got to.

### The container does the fetching, not the Worker

Safely fetching a caller-supplied URL means checking the **resolved address**
before connecting, so a hostname cannot pass a check and then answer with
`169.254.169.254`. A Worker's `fetch` gives you no visibility into resolution; a
container has a real DNS stack. That is why `/import` lives in
[`container/server.mjs`](services/imgman/container/server.mjs).

Redirects are followed by hand, re-validating every hop. `redirect: 'follow'`
would check only the original address — a public host is then free to redirect
you straight at the metadata endpoint. `redirect: 'error'` is safe but useless,
because ordinary image URLs redirect constantly.

> `imgman` has no public hostname in any deployed environment. That is **least
> privilege, not the security control** — the entry point is `web`, which is
> public either way, so an extra hop buys nothing against SSRF. The guards are
> the control, and they live next to the fetch they protect.

### Expression interpolation in workflows

[`pullrequest.yml`](.github/workflows/pullrequest.yml) routes its expression
through `env`; [`quality.yml`](.github/workflows/quality.yml) interpolates
`inputs.prepare` straight into a shell line. The distinction is the source:
`workflow_call` inputs are set by a sibling workflow file in this repo and are
exactly as trustworthy as it is, whereas anything derived from a pull request —
titles, branch names, bodies — is attacker-controlled and must never reach a
shell that way.

---

## What this deliberately does not do

Each of these was considered and cut. They are listed with what adding them
would involve, because the shape of the extension is usually the interesting
part.

### Accounts, sessions and permissions

There are none. A board is a URL you know, and a share link is a credential:
whoever holds it gets the access it carries, and there is no way to revoke one.
The Durable Object enforces the view/edit distinction over the socket, but the
REST routes do not re-check a token on every write.

> **Adding it:** a `users` table, a session mechanism, an ownership column on
> `boards`, and a check in one place that every route already passes through
> (`useCloudflare`). None of it would teach you anything about Cloudflare
> bindings, which is why it is not here.

### Vectorize for face search

See [Design notes](#embeddings-live-in-d1-not-in-a-vector-database). The short
version is that a linear scan over a board's faces is faster than a network hop,
and Vectorize has no local emulation — adding it would mean `pnpm dev` stops
working without a Cloudflare account.

> **Adding it:** feature-detect the binding so the app behaves exactly as it does
> today when it is absent, write each embedding to an index namespaced by board
> as well as to the D1 blob, and query it instead of scanning when it is
> present. The threshold and the match logic do not change.

### Recognising a face across boards

People are scoped to a board, and deliberately: the same face in two
investigations is two people as far as this is concerned. Matching never looks
outside the board it was asked about.

### Edit-before-commit for imports

The intended richer flow is: import stages the fetched image, the user crops and
adjusts it, and only the final version is committed. The container already has
the tooling, and the media modal was built as a room of its own so a step could
be added between choosing a file and it landing on the board.

> **Adding it:** stage fetched bytes under a `staging/` prefix in R2 with a
> lifecycle rule to expire them, send _edit operations_ (crop box, rotation,
> adjustments) rather than re-uploaded pixels so the container applies them to
> the full-resolution original, and commit on save. An abandoned import then
> cleans itself up.

### Streaming between Worker and container

Bytes move as base64 in JSON. One response is far easier to follow than a
multipart one, and demo images are small. A production version would stream both
parts and cap memory.

### Full DNS-rebinding protection

Each hop resolves once for the check and again inside `fetch`, so a hostile DNS
server could answer differently the second time. Closing it fully means
connecting to the validated IP directly and carrying the `Host` header. The gap
is named in the code rather than hidden.

### Publishing the preset to npm

It is consumed via `workspace:*`. It is nonetheless shaped as a publishable
package — clean exports, its own build — so a fork can publish it under its own
name without restructuring anything.

### Conflict resolution beyond last-write-wins

Two people dragging the same card is resolved by whoever's settled move arrives
last. Presence makes that visible rather than mysterious — you can see the other
cursor holding the card — and at the scale a shared board operates at, that is
the honest amount of machinery. CRDTs would be a different project.

---

## Troubleshooting

**"Cloudflare bindings unavailable: DB, R2, IMGMAN, BOARD" on a deployed
preview.** All four at once is the tell — a genuine misconfiguration loses one.
It means `event.context.cloudflare` was never populated, not that the worker is
missing its bindings; check the Worker in the dashboard and they will all be
there. See [Bindings](#bindings) for why, and reach bindings through
`useCloudflare(event)` rather than the context. `GET /api/health` lists what the
worker can actually see and exercises each one.

**Changes to the preset seem to do nothing.** `extends` loads the preset from
`dist/`. Rebuild it:

```bash
pnpm --filter nitro-cloudflare-monorepo build
```

**Reclaiming Docker disk.** Local container images accumulate across projects:

```bash
# What is there, and how much space it is using
docker images --filter 'reference=cloudflare-dev/*'

# Remove all of them. They are dev-only images; the next `pnpm dev` rebuilds
# whichever one this repo actually needs.
docker images --filter 'reference=cloudflare-dev/*' -q | xargs -r docker rmi
```

If other repositories on the same machine also build `cloudflare-dev/*` images,
narrow it to this one — the image name comes from the container's Durable Object
class:

```bash
docker images --filter 'reference=cloudflare-dev/imagecontainer' -q | xargs -r docker rmi
```

The content-hashed tagging in this preset stops _this_ repo from adding a new
multi-gigabyte image on every dev restart, but it cannot clean up what other
tools left behind.

**"Another Nuxt dev is already running".** A previous dev server is still alive
and will keep serving _stale_ code while your new one refuses to start. Stop it
before restarting — Ctrl-C in its terminal shuts the whole process group down,
workerd included.

Worse than refusing: if the second one lands on **port 3001** instead, you now
have two Miniflare instances opening the same SQLite files under
`.wrangler/state` and fighting over one container name. Symptoms are arbitrary.
Check with `ss -ltn | grep :300` before diagnosing anything stranger.

**`SQLite alarm handler canceled with requestScheduledAlarm`.** Also a warning
logged at ERROR level, also nothing to do. The `actorId` in it belongs to the
**image container's** Durable Object — you can check: it is the filename under
`web/.wrangler/state/v3/do/skein-imgman-dev-ImageContainer/`. `@cloudflare/containers`
uses an alarm to implement `sleepAfter`, and on start-up it finds an alarm time
persisted by a previous dev session and reschedules it. Nothing in this
repository sets that alarm, and the board's own write-behind alarm is a
different object entirely.

**`Could not bind egress listener to gateway address … 172.17.0.1`.** workerd
logs this at ERROR level; read its own text and it says _warning_, _falling back
to loopback_. It is trying to bind the container's outbound listener to the
Docker bridge gateway, which is not a host interface under Docker Desktop on
WSL2. Uploads, URL imports and face detection all work anyway — verified with
that line in the log. Nothing to fix.

**An upload fails right after the container has been idle.** `fetch` on a
container starts a stopped instance but does not wait for the process inside to
bind its port, so a request arriving in that window used to come back as a
runtime error string — surfacing as `Unexpected token 'F'` from a JSON parse,
which names neither the container nor the reason. `imgman` now calls
`startAndWaitForPorts` first and reports what actually came back if it is not
JSON. If you see it again, restarting `pnpm dev` clears Miniflare's container
state.

**A push to `main` reports "not configured to deploy".** Expected on a fork
that has not been through [Deploying your own fork](#deploying-your-own-fork)
yet. Production deploys are opt-in: with any of the four required values
missing, the workflow says which ones and skips rather than failing. Nothing is
deployed and nothing is broken.

**A preview deploy fails with `[10061]`.** Something binds a Durable Object
class in a script that does not exist yet. Check that `board` deployed before
`web`; the ordering is enforced in
[`preview.yml`](.github/workflows/preview.yml).

**R2 bucket creation fails with `10429`.** Bucket create/delete is rate limited
per _account_, and every attempt spends the same budget — so retrying makes it
worse. Wait, then re-run the job; it skips creation if the bucket now exists.

---

## License

Dual licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Attribution is the only thing asked of you. The [NOTICE](NOTICE) file exists
because Apache-2.0 §4(d) requires redistributors to carry its contents forward,
which gives that request some teeth.

> **Why dual?** It matches Cloudflare's own `workers-sdk`, which means anything
> here can be lifted upstream without a licence-compatibility conversation.
> Apache-2.0 adds an explicit patent grant that some legal reviews require; MIT
> is the low-friction default. Downstream picks.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
