/**
 * Put a board together that demonstrates face matching, against a running dev
 * server.
 *
 *   pnpm dev          # in one terminal
 *   pnpm seed         # in another
 *
 * The photographs are NOT committed. They are fetched from Wikimedia Commons at
 * seed time, which keeps a repository that is mostly prose and TypeScript from
 * carrying a few megabytes of JPEG forever — and means the licence for each one
 * stays where it is documented rather than being reproduced here badly.
 *
 * They are public-domain portraits of people who died a long time ago, chosen
 * because the same person appears in more than one of them. That is the whole
 * requirement: matching cannot be demonstrated with one photograph each. It also
 * seemed worth not building a face-recognition demo around photographs of
 * anybody who might mind.
 *
 * What it proves, if it works: upload six photographs, name ONE face, and the
 * other photograph of that person is labelled without being touched — and the
 * string between the two cards appears, because those are derived from a shared
 * person rather than drawn by hand.
 */
const BASE = process.env.SKEIN_URL ?? 'http://localhost:3000'

/**
 * Commons file names, resolved through Special:FilePath so the URL stays stable.
 *
 * Two photographs each, of three people, plus one person who appears only once.
 * Two is the minimum that can demonstrate anything: the first is what somebody
 * identifies by hand, and the second is what the machine is supposed to work out
 * on its own. Tesla is here with a single photograph deliberately — somebody who
 * appears once should stay unmatched, and a demo that only shows the happy case
 * is not showing much.
 */
const PORTRAITS: { person: string; first: string; second?: string }[] = [
    {
        person: 'Marie Curie',
        first: 'Marie_Curie_c._1920s.jpg',
        second: 'Marie_Curie_(Nobel-Chem).png',
    },
    {
        person: 'Albert Einstein',
        first: 'Albert_Einstein_Head.jpg',
        second: 'Einstein_1921_by_F_Schmutzer_-_restoration.jpg',
    },
    {
        person: 'Grace Hopper',
        first: 'Commodore_Grace_M._Hopper,_USN_(covered).jpg',
        second: 'Grace_Hopper.jpg',
    },
    { person: 'Nikola Tesla', first: 'N.Tesla.JPG' },
]

/**
 * A photograph the matching is NOT expected to solve, imported last on purpose.
 *
 * Four people around a UNIVAC in a 513-pixel-wide press photo: the faces are
 * about forty pixels across, several are turned away, and one of them is Grace
 * Hopper. It is there because a board of clean studio portraits would give a
 * misleading impression of what this does. Detection finds the faces; the
 * embeddings are too thin to be sure who they belong to, and the honest outcome
 * is boxes nobody has named.
 */
const GROUP_PHOTOS = ['Grace_Hopper_and_UNIVAC.jpg']

const commons = (file: string) =>
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=900`

async function send<T>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`)
    return JSON.parse(text) as T
}

const post = <T>(path: string, body: unknown) => send<T>('POST', path, body)
const patch = <T>(path: string, body: unknown) => send<T>('PATCH', path, body)

async function main() {
    const health = (await fetch(`${BASE}/api/health`).then((r) => r.json())) as {
        healthy: boolean
        checks: Record<string, string>
    }
    if (!health.healthy) {
        console.error('The dev server is up but its bindings are not:', health.checks)
        console.error('Face detection needs the image container, which needs Docker.')
        process.exit(1)
    }

    const board = await post<{ id: string }>('/api/boards', { title: 'Who knows whom' })
    const url = `${BASE}/b/${board.id}`
    console.info(`board ${url}\n`)

    const load = () =>
        fetch(`${BASE}/api/boards/${board.id}`).then((r) => r.json()) as Promise<{
            cards: { id: string }[]
            faces: { id: string; cardId: string; personId: string | null }[]
            links: { kind: string }[]
        }>

    // Imported one at a time rather than in parallel: the container has a
    // quarter of a vCPU, and several concurrent decodes on it is slower than the
    // same work in sequence as well as harder to read when something fails.
    const importOne = async (file: string) => {
        const result = await post<{ card: { id: string }; recognised: string[] }>('/api/import', {
            url: commons(file),
            boardId: board.id,
        })
        return result
    }

    console.info('1. one photograph of each person')
    const firsts = new Map<string, string>()
    for (const portrait of PORTRAITS) {
        const { card } = await importOne(portrait.first)
        firsts.set(portrait.person, card.id)
        console.info(`   ${portrait.first}`)
    }

    console.info('\n2. identify each of them, by hand, once')
    const board1 = await load()
    for (const portrait of PORTRAITS) {
        const cardId = firsts.get(portrait.person)
        const face = board1.faces.find((f) => f.cardId === cardId)
        if (!face) {
            console.info(`   ${portrait.person}: no face detected, skipping`)
            continue
        }
        await patch(`/api/faces/${face.id}`, { name: portrait.person })
        console.info(`   ${portrait.person}`)
    }

    console.info('\n3. the second photograph of each — nobody names these')
    let recognised = 0
    for (const portrait of PORTRAITS) {
        if (!portrait.second) continue
        const result = await importOne(portrait.second)
        if (result.recognised.length > 0) recognised += 1
        console.info(
            `   ${portrait.second}` +
                (result.recognised.length
                    ? `  ->  recognised ${result.recognised.join(', ')}`
                    : '  ->  no match')
        )
    }

    console.info('\n4. a hard one — small, angled faces in a press photograph')
    for (const file of GROUP_PHOTOS) {
        const result = await importOne(file)
        console.info(
            `   ${file}` +
                (result.recognised.length
                    ? `  ->  recognised ${result.recognised.join(', ')}`
                    : '  ->  faces found, nobody identified (expected)')
        )
    }

    const final = await load()
    const identified = final.faces.filter((f) => f.personId).length
    const derived = final.links.filter((l) => l.kind === 'person').length
    const expected = PORTRAITS.filter((p) => p.second).length

    console.info(
        `\n${final.cards.length} cards, ${final.faces.length} faces detected, ` +
            `${identified} identified, ${derived} string(s) derived`
    )
    console.info(`${recognised}/${expected} second photographs recognised without being named`)
    console.info(`\nopen ${url}`)

    if (recognised < expected) {
        console.error('\nSome were missed — see MATCH_THRESHOLD in server/utils/faces.ts')
        process.exit(1)
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
