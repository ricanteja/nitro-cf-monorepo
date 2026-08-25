/**
 * A display name for someone who never signed in.
 *
 * Ubuntu's release names — alliterative adjective plus animal — because a shared
 * board needs names people can say out loud and tell apart at a glance. "Warty
 * Warthog" is memorable in a way "guest-4f2a" is not, and on a board where the
 * only thing distinguishing two editors is a coloured dot, being able to say
 * "the warthog moved it" is most of what presence is for.
 *
 * Alliteration is not decoration: it halves the space of plausible-looking names,
 * so two people are far more likely to differ in the ANIMAL — the part that
 * carries the meaning — than to differ only in an adjective nobody registers.
 *
 * The four digits are the collision handling. With this many pairs a room of a
 * dozen people would still hit a duplicate now and then, and two identical names
 * in a presence list is worse than an ugly one.
 */
const NAMES: Record<string, [string[], string[]]> = {
    b: [
        ['Bold', 'Brisk', 'Brave'],
        ['Badger', 'Bison', 'Beetle'],
    ],
    c: [
        ['Candid', 'Clever', 'Calm'],
        ['Curlew', 'Crane', 'Cobra'],
    ],
    d: [
        ['Dapper', 'Deft', 'Dogged'],
        ['Dingo', 'Dormouse', 'Drake'],
    ],
    f: [
        ['Fearless', 'Fleet', 'Frank'],
        ['Falcon', 'Ferret', 'Finch'],
    ],
    g: [
        ['Gallant', 'Genial', 'Grave'],
        ['Gannet', 'Gecko', 'Grouse'],
    ],
    h: [
        ['Hardy', 'Hearty', 'Humble'],
        ['Heron', 'Hornet', 'Hare'],
    ],
    j: [
        ['Jaunty', 'Jovial', 'Just'],
        ['Jackal', 'Jay', 'Jerboa'],
    ],
    k: [
        ['Keen', 'Kindly', 'Knowing'],
        ['Kestrel', 'Koala', 'Kite'],
    ],
    l: [
        ['Lucid', 'Lively', 'Loyal'],
        ['Lemur', 'Lynx', 'Lapwing'],
    ],
    m: [
        ['Mellow', 'Merry', 'Mindful'],
        ['Marmot', 'Magpie', 'Mongoose'],
    ],
    n: [
        ['Nimble', 'Noble', 'Novel'],
        ['Narwhal', 'Newt', 'Nightjar'],
    ],
    o: [
        ['Oblique', 'Opal', 'Ornate'],
        ['Ocelot', 'Otter', 'Osprey'],
    ],
    p: [
        ['Patient', 'Placid', 'Prudent'],
        ['Puffin', 'Pika', 'Panther'],
    ],
    q: [
        ['Quick', 'Quiet', 'Quirky'],
        ['Quail', 'Quokka', 'Quetzal'],
    ],
    r: [
        ['Rapid', 'Ready', 'Rustic'],
        ['Raven', 'Rabbit', 'Robin'],
    ],
    s: [
        ['Steady', 'Sunny', 'Solemn'],
        ['Serval', 'Starling', 'Stoat'],
    ],
    t: [
        ['Tactful', 'Tidy', 'Trusty'],
        ['Tapir', 'Teal', 'Toucan'],
    ],
    v: [
        ['Valiant', 'Vivid', 'Verdant'],
        ['Vervet', 'Viper', 'Vole'],
    ],
    w: [
        ['Wary', 'Willing', 'Witty'],
        ['Wombat', 'Walrus', 'Weasel'],
    ],
    z: [
        ['Zealous', 'Zesty', 'Zippy'],
        ['Zebra', 'Zebu', 'Zorilla'],
    ],
}

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!

/** e.g. "Nimble Narwhal 4821". */
export function generateDisplayName(): string {
    const letter = pick(Object.keys(NAMES))
    const [adjectives, animals] = NAMES[letter]!
    const code = String(Math.floor(Math.random() * 9000) + 1000)
    return `${pick(adjectives)} ${pick(animals)} ${code}`
}

/**
 * The two or three letters that go in a presence badge.
 *
 * Taken from the WORDS rather than the first characters, because "Nimble
 * Narwhal 4821" and "Nimble Nightjar 9033" share a prefix and would otherwise
 * both come out as "Ni".
 */
export function initialsOf(name: string): string {
    const words = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
    if (words.length === 0) return name.slice(0, 2).toUpperCase()
    return words
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join('')
}
