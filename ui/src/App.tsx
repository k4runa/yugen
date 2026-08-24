import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const LAYOUT_KEY = 'yugen.layout'

const AURA_RANGE = [0, 100] as const

// widths are shares of the window, so the columns keep following it after a manual resize.
// the rem pair is the floor/ceiling css clamps them to at extreme window sizes.
const SIDEBAR_RANGE = [8, 26] as const
const RAIL_RANGE = [10, 30] as const
const SIDEBAR_BOUNDS = [9, 22] as const
const RAIL_BOUNDS = [10, 26] as const

// how much room the main column needs before the right rail is in the way
const MAIN_MIN = 34

const column = ([min, max]: readonly [number, number], percent: number) =>
    `clamp(${min}rem, ${percent}%, ${max}rem)`

// what the css clamp above resolves to, in px
const column_px = (
    [min, max]: readonly [number, number],
    percent: number,
    frame: number,
    rem: number,
) => Math.min(Math.max((frame * percent) / 100, min * rem), max * rem)

const clamp = (value: number, [min, max]: readonly [number, number]) =>
    Math.min(Math.max(value, min), max)

// webkit keeps localStorage under ~/.local/share/yugen, so this survives a restart
function stored_width(key: 'sidebar' | 'rail', fallback: number, range: readonly [number, number]) {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')[key]
        return typeof value === 'number' && Number.isFinite(value) ? clamp(value, range) : fallback
    } catch {
        return fallback
    }
}

function stored_pref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')[key]
        return allowed.includes(value) ? value : fallback
    } catch {
        return fallback
    }
}

// pinned playlists live here rather than in playlists.json, which has no field for them
function stored_flag(key: string, fallback: boolean) {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')[key]
        return typeof value === 'boolean' ? value : fallback
    } catch {
        return fallback
    }
}

function stored_pins(): string[] {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').pins
        return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : []
    } catch {
        return []
    }
}

function stored_shelves(): Shelf[] {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').shelves
        const ids = SHELVES.map((shelf) => shelf.id)

        return Array.isArray(value) ? value.filter((id: Shelf) => ids.includes(id)) : []
    } catch {
        return []
    }
}

function stored_number(key: string, fallback: number, [min, max]: readonly [number, number]) {
    try {
        const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')[key]
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.min(Math.max(value, min), max)
            : fallback
    } catch {
        return fallback
    }
}

function save_pref(key: string, value: string | string[] | boolean | number) {
    try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, [key]: value }))
    } catch {
        // storage unavailable, the choice just will not stick
    }
}

const THEMES = ['system', 'light', 'dark'] as const
type Theme = (typeof THEMES)[number]

const VIEWS = ['library', 'liked', 'albums', 'artists', 'playlist'] as const
type View = (typeof VIEWS)[number]

/*
 * What was playing when the app last went away. It is written while the track
 * runs rather than on the way out: webkitgtk does not reliably give the page a
 * turn when the window closes, so the last tick that made it to disk is what a
 * restart picks up. Kept apart from the layout blob because it is rewritten
 * every second and none of it is a preference.
 */
const PLAYBACK_KEY = 'yugen.playback'

/*
 * Shuffle is three states rather than a switch: off, the listing you are
 * standing in, or the whole library. Which one is on says what the order was
 * drawn from - and once it is drawn it stands, so walking into another playlist
 * does not quietly deal a new one behind whatever is playing.
 */
type Shuffle = 'off' | 'listing' | 'all'

const SHUFFLES: { id: Shuffle; label: string; hint: string }[] = [
    { id: 'off', label: 'No shuffle', hint: 'Play in order' },
    { id: 'listing', label: 'Shuffle this listing', hint: 'Only what is on screen' },
    { id: 'all', label: 'Shuffle everything', hint: 'The whole library' },
]

type Playback = {
    song: string
    position: number
    // the listing the queue was built from, so prev/next carry on where they left off
    view: View
    selection: string | null
    shuffle: Shuffle
}

function stored_playback(): Playback | null {
    try {
        const value = JSON.parse(localStorage.getItem(PLAYBACK_KEY) ?? 'null')

        if (!value || typeof value.song !== 'string') return null

        return {
            song: value.song,
            position:
                typeof value.position === 'number' && Number.isFinite(value.position)
                    ? Math.max(value.position, 0)
                    : 0,
            view: VIEWS.includes(value.view) ? value.view : 'library',
            selection: typeof value.selection === 'string' ? value.selection : null,
            // it was a switch before it was three states, and 'on' meant the
            // listing you were standing in
            shuffle:
                value.shuffle === true
                    ? 'listing'
                    : SHUFFLES.some((option) => option.id === value.shuffle)
                      ? value.shuffle
                      : 'off',
        }
    } catch {
        return null
    }
}

function save_playback(state: Playback) {
    try {
        localStorage.setItem(PLAYBACK_KEY, JSON.stringify(state))
    } catch {
        // storage unavailable, the next launch just comes up empty
    }
}

// the album and artist rows are keyed off these, and a blank tag falls into one
// shared bucket rather than a nameless one of its own
const artist_tag = (meta?: string[]) => meta?.[1] || 'Unknown artist'
const album_tag = (meta?: string[]) => meta?.[2] || 'Unknown album'
const group_key = (tag: string) => tag.trim() || 'Unknown'

// the eleven characters youtube names a video by, which yt-dlp leaves on the end
// of the file name - and the file name is what a title falls back to when the
// download arrived carrying no tags at all
const VIDEO_ID = /\s*\[[\w-]{11}\]\s*$/

// the words a video carries that a song does not. a bracket only comes off when
// one of them is inside it, which leaves '(feat. ...)' and every other bracket
// that is genuinely part of the title where it is.
const VIDEO_NOISE =
    /\s*[([][^()[\]]*\b(?:official|lyrics?|audio|video|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|m\/?v)\b[^()[\]]*[)\]]/gi

// what a channel is called rather than what the band is: yt-dlp fills the artist
// tag from the uploader, and an uploader is the name with 'Official' after it,
// the auto-generated '- Topic' feed, or a vevo account
const CHANNEL = /\s*(?:-\s*topic|official|vevo)\s*$/i

// 'Artist - Song', the way a video is titled
const TITLE_SPLIT = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/

// a video title quotes the name of the song inside it, and the quotes belong to
// the video. only a title wrapped in them end to end is unwrapped, so 'Don't'
// and 'Rock 'n' Roll' keep every mark they were written with.
const QUOTED = /^["'\u2018\u201c](.+)["'\u2019\u201d]$/

// where the tag lists everyone who played, last.fm is holding the first name only
const asked_artist = (tag: string) => tag.split(',')[0].replace(CHANNEL, '').trim()

/*
 * The two names to ask about, out of the two on the file.
 *
 * Neither tag can be taken as given, because neither was written by anyone who
 * had a music library in mind: yt-dlp puts the video's title in one and the
 * channel's name in the other, so a download arrives as 'Girlfriends' playing
 * 'Girlfriends - Untitled #3', or as 'Don Giovanni' - the label - playing
 * 'LSD and the Search for God - "Starting Over"'. Neither last.fm nor lrclib
 * knows a song by either of those names.
 *
 * So the video's dressing comes off, and then the dash in the title decides:
 *
 *   - nothing in front of it that reads as an artist, and the tag stands.
 *   - the tag repeated in front of it, and the repeat is what comes off.
 *   - something else in front of it, and that is taken over the tag. What sits
 *     in front of a dash in a video's title is the artist far more often than a
 *     channel name is, and a title that keeps its dash is one last.fm has never
 *     heard of anyway - so there is nothing being given up by guessing here.
 */
function asked(title: string, artist: string) {
    const track = title.replace(VIDEO_ID, '').replace(VIDEO_NOISE, '').trim()
    // the stand-in a missing tag falls into is not a name to go looking for
    const named = artist === 'Unknown artist' ? '' : asked_artist(artist)

    const bare = (name: string) => name.trim().replace(QUOTED, '$1').trim()

    const split = TITLE_SPLIT.exec(track)
    if (!split) return { artist: named, track: bare(track) || title }

    const [, front, rest] = split
    const repeated = front.trim().toLowerCase() === named.toLowerCase()

    return { artist: repeated ? named : front.trim(), track: bare(rest) }
}

// right-click targets: a track, a playlist in the sidebar, or the sidebar itself
type MenuTarget =
    | { kind: 'song'; song: string }
    | { kind: 'playlist'; playlist: string }
    | { kind: 'sidebar' }
    // a track that is not here yet: the menu is where it is fetched from
    | { kind: 'suggestion'; track: Suggestion }

type Menu = MenuTarget & { x: number; y: number }

// the only thing a dialog is still for: editing a playlist's details
type Dialog = { playlist: string }

type Sort = 'title' | 'added' | 'artist' | 'album'
type Layout = 'list' | 'compact' | 'grid'

const SORTS: { id: Sort; label: string }[] = [
    { id: 'title', label: 'Title' },
    { id: 'added', label: 'Recently added' },
    { id: 'artist', label: 'Artist' },
    { id: 'album', label: 'Album' },
]

// how many of a thing a shelf on the library page holds
const SHELF = 10

// how many suggestions a full shelf holds. a pass digs four times as deep as
// that before it gives up: last.fm rarely has a picture on the similar list
// itself, so most of what is found costs one more request before it can be
// shown, and the ones with nothing behind them are dropped.
const SUGGESTIONS = 60

// one artist is allowed this many places on the shelf. last.fm answers a seed
// with a lot of the same name, so without a ceiling a pass reads as one back
// catalogue rather than as a spread of what else there is.
const PER_ARTIST = 3

// the collection's size in time: hours once there are any, minutes below that
function format_span(seconds: number) {
    if (!seconds) return ''

    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)

    return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

const LAYOUTS: { id: Layout; label: string }[] = [
    { id: 'list', label: 'List' },
    { id: 'compact', label: 'Compact' },
    { id: 'grid', label: 'Grid' },
]

type Shelf = 'playlists' | 'albums' | 'artists'

// which listing a layout belongs to, and the key it is remembered under
type LayoutKey = 'library' | 'liked' | 'playlist' | 'group'

const LAYOUT_PREFS: Record<LayoutKey, string> = {
    library: 'library_layout',
    liked: 'liked_layout',
    // what the playlist layout has been saved as since before the others existed
    playlist: 'track_layout',
    group: 'group_layout',
}

type LibraryView = 'compact' | 'list' | 'compact-grid' | 'grid'

const LIBRARY_VIEWS: { id: LibraryView; label: string }[] = [
    { id: 'compact', label: 'Compact' },
    { id: 'list', label: 'List' },
    { id: 'compact-grid', label: 'Compact grid' },
    { id: 'grid', label: 'Default grid' },
]

// the shelf is the same set of records read four ways: the last one is not a
// shape but a grouping, which is why it lives here rather than with LAYOUTS
type SuggestionView = 'grid' | 'compact' | 'list' | 'artist'

const SUGGESTION_VIEWS: { id: SuggestionView; label: string }[] = [
    { id: 'grid', label: 'Grid' },
    { id: 'compact', label: 'Compact' },
    { id: 'list', label: 'List' },
    { id: 'artist', label: 'By artist' },
]

type Source = 'yt' | 'sc'

type SearchResult = {
    title: string
    // a video id on youtube, the track's page url on soundcloud
    ref: string
    thumbnail?: string
}

// one search shells out to yt-dlp once and asks for a whole batch - the backend
// has its own floor under this - because a second search costs another subprocess
// while slicing a list that is already here costs nothing
const BATCH = 50
// but the whole batch is not put on screen: every row holds a remote thumbnail,
// and fifty of those live at once is what the dropdown pays for in memory
const PAGE = 10

const SOURCES: { id: Source; label: string }[] = [
    { id: 'yt', label: 'YouTube' },
    { id: 'sc', label: 'SoundCloud' },
]

// what the source prints per result, and the shape of its second field: an
// 11-character video id on youtube, the track's page url on soundcloud
const SHAPE: Record<Source, { fields: number; ref: RegExp }> = {
    yt: { fields: 2, ref: /^[\w-]{11}$/ },
    sc: { fields: 3, ref: /^https?:\/\/(www\.)?soundcloud\.com\/.+/ },
}

// yt-dlp prints NA for anything the flat listing does not carry
const printed = (value?: string) => (value && value !== 'NA' ? value : undefined)

// both searches print one flat list, a fixed number of lines per result
async function run_search(on: Source, query: string): Promise<SearchResult[]> {
    try {
        const flat =
            on === 'yt'
                ? await bridge().search_yt(query, BATCH)
                : await bridge().search_sc(query, BATCH)

        const { fields, ref } = SHAPE[on]

        return Array.from({ length: Math.floor(flat.length / fields) }, (_, i) => ({
            title: flat[i * fields],
            ref: flat[i * fields + 1],
            thumbnail: printed(flat[i * fields + 2]),
        }))
            // a flat search also turns up channels and playlists, which are not tracks
            .filter((result) => ref.test(result.ref))
    } catch {
        // yt-dlp is a subprocess and can simply fail; an empty answer is not
        // remembered, so the next enter goes back out
        return []
    }
}

// download_with_ytdlp writes `<title> [<id>].mp3`, so a file in the library
// carries both halves a search result can be recognised by
function library_mark(name: string) {
    const base = name.replace(/\.[^.]*$/, '')
    const open = base.lastIndexOf(' [')

    return open > 0 && base.endsWith(']')
        ? { title: base.slice(0, open), id: base.slice(open + 2, -1) }
        : { title: base, id: '' }
}

// punctuation is where the two sides disagree - yt-dlp swaps out whatever the
// filesystem will not take - so a title comparison keeps letters and digits only
const fold = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/* ---------- what else there is ---------- */

// the backend answers for one track at a time by design, so a pass is many
// small calls rather than one big one: a sample of the tracks the listener has
// actually marked, each asked about on its own.
const SEEDS = [60, 110] as const
const PER_SEED = [50, 60] as const

// a pass does not only ask about what carries a heart. this share of its seeds
// is drawn from the rest of the folder instead, so the shelf hears from more
// than the handful of tracks that have been marked - the ones that have are
// still the larger half of it.
const WIDER_SHARE = 0.4

// what is on screen before 'load more'
const SUGGESTION_PAGE = 20

// the shelf at the foot of a listing is a list rather than a wall of covers, so
// it holds fewer and uncovers them a handful at a time
const NEARBY = 30
const NEARBY_PAGE = 10

// every call runs on a thread of its own on the far side and ends in a request
// to last.fm, which asks for about five a second: the work is walked a few at a
// time rather than all at once, and this is the width of that walk
const LANES = 4

// what a pass was asked for: a shelf being filled, the same shelf asked again
// for different names, or more piled under what is already on it
type Mood = 'new' | 'again' | 'more'

type Suggestion = {
    // artist and title folded together: what tells two answers apart, and what
    // a track already on disk is recognised by
    key: string
    artist: string
    title: string
    // last.fm's own artwork for the track, as a url. a suggestion without one
    // never reaches the screen, so this is always set by the time it is read.
    image: string
    // how close last.fm thinks it is to the seed, which is the order they read in
    match: number
}

/*
 * The backend hands its answer over as text - one json library in the binary is
 * enough, and the one it has is not the one saucer serialises with - so the
 * reading is done here. Anything that does not come back as an array is a seed
 * with nothing to say, which is the same as an empty one: a pass carries on
 * around it rather than failing over it.
 */
function as_similar(answer: string): SimilarTrack[] {
    if (!answer) return []

    try {
        const parsed = JSON.parse(answer)

        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

/*
 * The one url out of a track.getInfo answer, read here for the same reason
 * as_similar is: what the backend hands over is last.fm's own reply, whole.
 *
 * What a track page carries is the album's cover rather than the track's, at
 * the largest size offered, and every step down to it is allowed to be missing
 * - a track last.fm knows by name but has no release for has no picture
 * either, which reads the same as an answer that never arrived.
 */
function as_cover(answer: string): string {
    if (!answer) return ''

    try {
        const images = JSON.parse(answer)?.track?.album?.image
        if (!Array.isArray(images)) return ''

        return images.find((i) => i?.size === 'extralarge')?.['#text'] ?? ''
    } catch {
        return ''
    }
}

/* ---------- what last.fm keeps on a track ---------- */

// more than four reads as a wall rather than as a description of the track
const TAGS = 4

// the parts of a track.getInfo answer the card in front of the player shows.
// every one of them is optional: last.fm answers for a track it barely knows
// with little more than the name it was asked about.
type TrackInfo = {
    album: string
    tags: string[]
    listeners: number
    playcount: number
    // out of the wiki entry, which dates the release rather than the writing
    year: string
    summary: string
}

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
    nbsp: ' ',
}

// last.fm writes its wiki entries as html and closes every one of them with a
// link back to its own page for the track. Neither belongs in a paragraph here,
// so the link goes first - trailing full stop and all - and what is left of the
// markup is unwrapped around what it was wrapping.
function as_prose(html: string) {
    return html
        .replace(/<a\b[^>]*>[\s\S]*?<\/a>\.?/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole)
        .replace(/\s+/g, ' ')
        .trim()
}

/*
 * One track.getInfo answer, read down to the handful of fields the card shows.
 *
 * Every step is reached for rather than assumed: the same endpoint answers with
 * a wiki and a tag list for a track it has an entry for, with a bare name and a
 * play count for one it does not, and with an error object for one it has never
 * heard of. None of the three is worth failing the card over, so anything that
 * is not there simply does not appear on it.
 */
function as_info(answer: string): TrackInfo | null {
    if (!answer) return null

    try {
        const track = JSON.parse(answer)?.track
        if (!track) return null

        // a track carrying one tag has it handed over as an object rather than
        // as a list of one, which is the only shape surprise in the answer
        const listed = track.toptags?.tag
        const tags: string[] = (Array.isArray(listed) ? listed : listed ? [listed] : [])
            .map((tag: { name?: string }) => tag?.name)
            .filter((name: unknown): name is string => typeof name === 'string' && !!name)

        const published: string = track.wiki?.published ?? ''

        return {
            album: typeof track.album?.title === 'string' ? track.album.title : '',
            tags: tags.slice(0, TAGS),
            listeners: Number(track.listeners) || 0,
            playcount: Number(track.playcount) || 0,
            year: published.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? '',
            summary: as_prose(track.wiki?.summary ?? ''),
        }
    } catch {
        return null
    }
}

// seven figures of listeners is a number nobody reads a digit of: what the line
// is for is the size of the thing, so the locale's own short form is what goes in
const counted = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
})

// the one grey star last.fm hands back for everything it has no picture for.
// get_similar already drops it on the way over; a track's own page does not,
// and that is the call nearly every card ends up going through.
const NO_PICTURE = '2a96cbd8b46e442fc41c2b86b821562f'

const picture = (url?: string) => {
    const src = (url ?? '').trim()

    return src.startsWith('http') && !src.includes(NO_PICTURE) ? src : ''
}

const between = ([min, max]: readonly [number, number]) =>
    min + Math.floor(Math.random() * (max - min + 1))

// a partial fisher-yates: only as much of the pool as is actually wanted gets
// shuffled, and the pool itself is left alone
function sample<T>(pool: T[], count: number) {
    const rest = [...pool]
    const wanted = Math.min(count, rest.length)

    for (let i = 0; i < wanted; i++) {
        const pick = i + Math.floor(Math.random() * (rest.length - i))
        ;[rest[i], rest[pick]] = [rest[pick], rest[i]]
    }

    return rest.slice(0, wanted)
}

/*
 * Last.fm answers a seed with a lot of the same name - ask it about one track
 * and half the list is that track's artist - so the closest hundred candidates
 * can easily be a dozen artists deep and nothing else. This deals them out in
 * rounds instead: everyone's closest first, then everyone's second closest,
 * and so on, up to PER_ARTIST each. The order within an artist is kept, so the
 * list still reads closest-first; it just stops being one name at a time.
 */
function spread_artists(tracks: Suggestion[]) {
    const by_artist = new Map<string, Suggestion[]>()

    for (const track of tracks) {
        const name = fold(track.artist) || track.key
        const held = by_artist.get(name)

        if (held) held.push(track)
        else by_artist.set(name, [track])
    }

    const dealt: Suggestion[] = []

    for (let round = 0; round < PER_ARTIST; round++) {
        for (const held of by_artist.values()) {
            if (held[round]) dealt.push(held[round])
        }
    }

    return dealt
}

// a fixed number of workers over one list: whichever lane comes free takes the
// next seed, so a slow one holds up nothing but itself
async function in_lanes<T, R>(items: T[], lanes: number, work: (item: T) => Promise<R>) {
    const done: R[] = new Array(items.length)
    let next = 0

    await Promise.all(
        Array.from({ length: Math.min(lanes, items.length) }, async () => {
            while (next < items.length) {
                const index = next++
                done[index] = await work(items[index])
            }
        }),
    )

    return done
}

// the functions main.cpp exposes through saucer
type Bridge = {
    fetch_songs(path: string): Promise<string[]>
    get_metadata(path: string): Promise<string[]>
    get_cover(path: string): Promise<string>
    get_lyrics(title: string, artist: string): Promise<string>
    set_activity(state: boolean): Promise<void>
    get_activity(): Promise<boolean>
    play_music(path: string, title: string, artist: string, album: string): Promise<void>
    get_position(): Promise<number>
    get_length(): Promise<number>
    stop(): Promise<void>
    resume(): Promise<void>
    toggle_loop(state: boolean): Promise<void>
    search_yt(query: string, count: number): Promise<string[]>
    search_sc(query: string, count: number): Promise<string[]>
    download_yt(id: string, path: string): Promise<string>
    download_sc(url: string, path: string): Promise<string>
    shuffle(songs: string[]): Promise<string[]>
    next(): Promise<string>
    prev(): Promise<string>
    is_finished(): Promise<boolean>
    seek(position: number): Promise<void>
    delete_song(path: string): Promise<void>
    get_liked_songs(): Promise<string[]>
    like_song(name: string): Promise<void>
    unlike_song(name: string): Promise<void>
    get_playlists(): Promise<string[]>
    get_playlist(playlist: string): Promise<string[]>
    // a playlist's own sleeve, as raw base64 the same way a track's cover comes
    // over. a playlist that has never been given one answers with nothing.
    get_playlist_cover(playlist: string): Promise<string>
    set_playlist_cover(playlist: string, base64_pic: string): Promise<boolean>
    create_playlist(playlist: string): Promise<boolean>
    // how many playlists exist, which is what a new one is named after
    get_playlist_count(): Promise<number>
    delete_playlist(playlist: string): Promise<boolean>
    rename_playlist(playlist: string, renamed: string): Promise<boolean>
    add_to_playlist(playlist: string, name: string): Promise<boolean>
    remove_from_playlist(playlist: string, name: string): Promise<boolean>
    set_volume(volume: number) : Promise<void>
    load_volume() : Promise<number>
    get_music_dir(): Promise<string>
    mpris_track(
        title: string,
        artist: string,
        album: string,
        path: string,
        cover: string,
    ): Promise<void>
    mpris_state(
        playing: boolean,
        position: number,
        length: number,
        volume: number,
        can_next: boolean,
        can_prev: boolean,
        loop: boolean,
        shuffle: boolean,
    ): Promise<void>
    mpris_seeked(position: number): Promise<void>
    get_username(): Promise<string>
    get_profile_picture(): Promise<string>
    get_biography(): Promise<string>
    set_username(username: string): Promise<boolean>
    set_profile_picture(img: string): Promise<boolean>
    set_biography(bio: string): Promise<boolean>
    get_favorite_songs(): Promise<FavoriteTrack[]>
    add_favorite_song(track: FavoriteTrack): Promise<boolean>
    remove_from_favorites(file_path: string): Promise<boolean>
    // one track in, the tracks last.fm puts next to it out - as json text
    // rather than an array, see as_similar. the path is read off disk to know
    // what is being asked about, the limit is per track, and an answer of ''
    // means the far side had no api key to ask with.
    get_similar(file_path: string, limit: number): Promise<string>
    // everything last.fm carries on one track's page, as the json text it
    // answered with. two things read it: the shelf, which wants the artwork out
    // of it and nothing else (as_cover, and it arrives placeholder and all - see
    // picture()), and the card in front of the player, which wants the rest.
    get_info(artist: string, track_name: string): Promise<string>
}

// what get_similar answers with, once the text has been read. the backend
// rebuilds each entry rather than passing last.fm's own on, so the image is
// blank wherever it only had the placeholder - which is most of them, and what
// the second look is for. the closeness is whatever json it was written as.
type SimilarTrack = {
    name: string
    artist: string
    image: string
    match: string | number
}

type FavoriteTrack = {
    title: string
    artist: string
    album: string
    file_path: string
}

declare global {
    interface Window {
        saucer: { exposed: Bridge }

        // where the backend delivers whatever the desktop asked of the mpris
        // interface - see the mpris block in the component below
        __yugen_mpris?: (cmd: string, arg: number) => void
    }
}

// webkit draws the native title tooltip itself and no stylesheet can reach it, so
// it is off everywhere and .tip below replaces it. spread onto anything that needs
// a label: the same string doubles as the accessible name for the icon-only buttons.
const tip = (text: string) => ({ 'data-tip': text, 'aria-label': text })

/*
 * A row that runs sideways has no vertical scroll of its own, so a wheel over it
 * would move the page underneath instead - and the row it is pointing at would
 * sit there. This turns the wheel a quarter turn for as long as the pointer is
 * over one. The listener has to be native and non-passive: react's own wheel
 * handler cannot cancel the page's scroll.
 */
const sideways = (box: HTMLElement | null) => {
    if (!box) return

    const on_wheel = (event: WheelEvent) => {
        // a trackpad already swiping sideways is left alone
        if (box.scrollWidth <= box.clientWidth) return
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return

        event.preventDefault()
        box.scrollLeft += event.deltaY
    }

    box.addEventListener('wheel', on_wheel, { passive: false })

    return () => box.removeEventListener('wheel', on_wheel)
}

// saucer injects the bridge on the window at runtime
const bridge = () => window.saucer.exposed

// the mpris calls are fire and forget: a missing binding is a backend from
// before the interface existed, and a machine with no session bus is still a
// perfectly good music player. neither is worth breaking a render over.
const mpris = (call: () => Promise<void>) => {
    try {
        void call().catch(() => {})
    } catch {
        // binding not exposed
    }
}

// the music folder is the backend's to decide, so it is asked for once and kept
// here. every call site appends a file name straight onto it, hence the slash.
let music_path = ''
async function music_dir() {
    if (!music_path) {
        const path = await bridge().get_music_dir()
        music_path = path.endsWith('/') ? path : `${path}/`
    }

    return music_path
}

function format_time(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
}

function format_date(seconds: number) {
    if (!seconds) return '--'

    const days = Math.floor((Date.now() / 1000 - seconds) / 86400)

    if (days <= 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 30) return `${days} days ago`

    return new Date(seconds * 1000).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    })
}

/* ---------- artwork atmosphere ---------- */

// the cover art is what the glass has to refract, so it is also what colours the app.
// one small canvas read per track: the cover is a data uri, so nothing taints it.
const ART_SIZE = 28

function art_accent(data: string): Promise<[number, number] | null> {
    return new Promise((resolve) => {
        const image = new Image()

        image.onerror = () => resolve(null)
        image.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = ART_SIZE

            const context = canvas.getContext('2d', { willReadFrequently: true })
            if (!context) return resolve(null)

            context.drawImage(image, 0, 0, ART_SIZE, ART_SIZE)

            const { data: pixels } = context.getImageData(0, 0, ART_SIZE, ART_SIZE)

            // 24 hue buckets, each weighted by how colourful and how mid-toned the pixel is:
            // near-black and near-white pixels carry no usable hue
            const weight = new Array(24).fill(0)
            const saturation = new Array(24).fill(0)

            for (let i = 0; i < pixels.length; i += 4) {
                const r = pixels[i] / 255
                const g = pixels[i + 1] / 255
                const b = pixels[i + 2] / 255

                const max = Math.max(r, g, b)
                const min = Math.min(r, g, b)
                const light = (max + min) / 2
                const delta = max - min

                if (delta < 0.08) continue

                const sat = delta / (1 - Math.abs(2 * light - 1))
                const hue =
                    60 *
                    (max === r
                        ? ((g - b) / delta + 6) % 6
                        : max === g
                          ? (b - r) / delta + 2
                          : (r - g) / delta + 4)

                // a bell around mid lightness, so shadows and blown highlights barely count
                const score = sat * (1 - Math.abs(light - 0.5) * 1.6)
                if (score <= 0) continue

                const bucket = Math.floor(hue / 15) % 24

                weight[bucket] += score
                saturation[bucket] += sat * score
            }

            let best = -1
            let top = 0

            for (let i = 0; i < 24; i++) {
                if (weight[i] > top) {
                    top = weight[i]
                    best = i
                }
            }

            if (best < 0) return resolve(null)

            // hold the saturation inside a readable band: raw cover values run either
            // washed out or neon, and both make the accent unusable as a text colour
            const mean = saturation[best] / weight[best]

            resolve([best * 15 + 7.5, Math.round(Math.min(Math.max(mean, 0.3), 0.72) * 100)])
        }

        image.src = `data:image/jpeg;base64,${data}`
    })
}

/* ---------- lyrics ---------- */

type Line = { at: number; text: string }

// lrclib answers with an lrc body when it has one and flat text when it does not,
// and get_lyrics hands whichever it got straight through
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g

function parse_lyrics(raw: string): Line[] | null {
    const lines: Line[] = []

    for (const row of raw.split(/\r?\n/)) {
        const stamps = [...row.matchAll(STAMP)]
        if (!stamps.length) continue

        const text = row.replace(STAMP, '').trim()

        for (const [, m, sec, frac] of stamps) {
            // the fraction is centiseconds at two digits and milliseconds at three
            const rest = frac ? Number(frac) / 10 ** frac.length : 0

            lines.push({ at: Number(m) * 60 + Number(sec) + rest, text })
        }
    }

    // an lrc file can carry its own metadata tags and nothing else, which is not
    // a timed lyric sheet
    if (lines.length < 2) return null

    return lines.sort((a, b) => a.at - b.at)
}

// a sheet keeps the line in force centred inside its own box, without dragging
// whatever the box sits in around it, so scrollIntoView is not an option here.
//
// both places the sheet is shown stay mounted while hidden, and centring a line
// nobody can see is layout work for nothing: 'showing' is what says which of the
// two is worth the scroll, and the other catches up when it comes back.
function useLineFollow(
    box: React.RefObject<HTMLDivElement | null>,
    line: number,
    showing: boolean,
) {
    useEffect(() => {
        const node = box.current
        if (!node || line < 0 || !showing) return

        const row = node.children[line] as HTMLElement | undefined
        if (!row) return

        node.scrollTo({
            top: row.offsetTop - node.clientHeight / 2 + row.offsetHeight / 2,
            behavior: 'smooth',
        })
    }, [box, line, showing])
}

// the backend is polled once a second, far too coarse to move a progress bar or
// to land a lyric on its line, so the gaps are filled in locally.
//
// the running figure goes to `paint` once a frame and `paint` writes it into the
// dom itself. nothing here holds state, so counting between the polls costs no
// react render at all.
function useFineClock(position: number, running: boolean, paint: (seconds: number) => void) {
    const draw = useRef(paint)
    draw.current = paint

    // the count is anchored to the last poll rather than to its own last guess,
    // so it can never drift further than one poll away from the backend
    const from = useRef(0)

    // declared first, so on the commit a poll lands this re-anchors before either
    // of the effects below reads it
    useLayoutEffect(() => {
        from.current = performance.now()
    }, [position, running])

    const at = (now: number) => (running ? position + (now - from.current) / 1000 : position)

    // one paint per render, so a pause, a drag or a track change still lands on
    // screen while the loop below is not running
    useLayoutEffect(() => {
        draw.current(at(performance.now()))
    })

    // and nothing is scheduled at all unless something is actually playing
    useLayoutEffect(() => {
        if (!running) return

        let id = requestAnimationFrame(function tick(now) {
            draw.current(at(now))
            id = requestAnimationFrame(tick)
        })

        return () => cancelAnimationFrame(id)
        // `at` closes over exactly these two, and the loop should only be rebuilt
        // when they move
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [position, running])
}

type Tip = { text: string; x: number; y: number; below: boolean }

// one tooltip for the whole app, delegated off [data-tip] and positioned against
// the viewport. an absolutely placed one would be clipped by the player and the
// sidebar, both of which have to keep their overflow.
function useTip() {
    const [tip, set_tip] = useState<Tip | null>(null)

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let host: HTMLElement | null = null

        const hide = () => {
            clearTimeout(timer)
            host = null
            set_tip(null)
        }

        const over = (e: PointerEvent) => {
            const target =
                (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null

            if (target === host) return

            clearTimeout(timer)
            host = target

            if (!target) return set_tip(null)

            const text = target.dataset.tip
            if (!text) return set_tip(null)

            // the pause before it appears is what keeps it from strobing as the
            // cursor crosses a row of buttons
            timer = setTimeout(() => {
                const rect = target.getBoundingClientRect()
                // no room above: it goes under the element instead
                const below = rect.top < 4.5 * 16

                set_tip({
                    text,
                    x: rect.left + rect.width / 2,
                    y: below ? rect.bottom + 8 : rect.top - 8,
                    below,
                })
            }, 420)
        }

        document.addEventListener('pointerover', over)
        document.addEventListener('pointerdown', hide)
        document.addEventListener('scroll', hide, true)
        window.addEventListener('blur', hide)

        return () => {
            clearTimeout(timer)
            document.removeEventListener('pointerover', over)
            document.removeEventListener('pointerdown', hide)
            document.removeEventListener('scroll', hide, true)
            window.removeEventListener('blur', hide)
        }
    }, [])

    return tip
}

// the outgoing artwork has to stay mounted while it fades, so the backdrop keeps both
function useCrossfade(src?: string) {
    const [layers, set_layers] = useState<{ id: number; src?: string }[]>([])
    const counter = useRef(0)

    useEffect(() => {
        counter.current += 1

        const entry = { id: counter.current, src }

        set_layers((prev) => [...prev.slice(-1), entry])

        const timer = setTimeout(
            () => set_layers((prev) => prev.filter((layer) => layer.id === entry.id)),
            900,
        )

        return () => clearTimeout(timer)
    }, [src])

    return layers
}

/* ---------- icons ---------- */

type IconProps = { d: string; size?: number; fill?: boolean }

function Icon({ d, size = 16, fill = false }: IconProps) {
    return (
        <svg
            className='ico'
            width={size}
            height={size}
            viewBox='0 0 24 24'
            fill={fill ? 'currentColor' : 'none'}
            stroke={fill ? 'none' : 'currentColor'}
            strokeWidth={1.7}
            strokeLinecap='round'
            strokeLinejoin='round'
        >
            <path d={d} />
        </svg>
    )
}

function Cover({ data, alt, className }: { data?: string; alt: string; className: string }) {
    return data ? (
        <img className={className} src={`data:image/jpeg;base64,${data}`} alt={alt} />
    ) : (
        <div className={`${className} placeholder`}>♪</div>
    )
}

// stored and handed back as a full data: url rather than raw base64 like the
// covers - the mime type varies (png or jpeg), so the prefix travels with it
// instead of being guessed on the way back out. a blank one falls back to a
// plain silhouette instead
function Avatar({ data, size, alt }: { data?: string; size: 'sm' | 'md' | 'lg'; alt: string }) {
    const icon_size = size === 'lg' ? 40 : size === 'md' ? 26 : 18
    return data ? (
        <img className={`avatar avatar-${size}`} src={data} alt={alt} />
    ) : (
        <div className={`avatar avatar-${size} placeholder`}>
            <Icon d={ICONS.user} size={icon_size} />
        </div>
    )
}

type HeartProps = {
    liked: boolean
    on_toggle: () => void
    size?: number
    className?: string
}

function Heart({ liked, on_toggle, size = 15, className = '' }: HeartProps) {
    return (
        <button
            className={`heart${liked ? ' liked' : ''}${className ? ' ' + className : ''}`}
            {...tip(liked ? 'Remove from liked songs' : 'Add to liked songs')}
            onClick={(e) => {
                e.stopPropagation()
                on_toggle()
            }}
        >
            <Icon d={ICONS.heart} size={size} fill={liked} />
        </button>
    )
}

const ICONS = {
    // the cone is shared, the arcs to its right are what the level changes
    volume_mute: 'M4 9.5h3L11 6v12l-4-3.5H4zM15.5 10l4 4m0-4-4 4',
    volume_low: 'M4 9.5h3L11 6v12l-4-3.5H4zM14.5 10a3 3 0 0 1 0 4',
    volume_high: 'M4 9.5h3L11 6v12l-4-3.5H4zM14.5 10a3 3 0 0 1 0 4M17 7.5a7 7 0 0 1 0 9',
    library: 'M4 20V9m4 11V4m4 16v-7m4 7V7m4 13v-4',
    heart: 'M19.5 12.6 12 20l-7.5-7.4a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l1 1 1-1a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5',
    album: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    artist: 'M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0',
    back: 'M15 5l-7 7 7 7',
    home: 'M3.5 11.5 12 4.5l8.5 7M6 10.2V20h12V10.2M10 20v-5h4v5',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5',
    system: 'M4 5h16v10H4zM9 19h6m-3-4v4',
    prev: 'M18 6v12L9 12zM7 6v12',
    next: 'M6 6v12l9-6zM17 6v12',
    play: 'M8 5.5v13l11-6.5z',
    pause: 'M9.5 5.5v13M14.5 5.5v13',
    loop: 'M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4',
    shuffle: 'M17 3l3 3-3 3M17 15l3 3-3 3M4 6h4l8 12h4M20 6h-4l-2 3M4 18h4l2-3',
    download: 'M12 4v11m-4-4 4 4 4-4M5 19h14',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
    trash: 'M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13M10 11v5m4-5v5',
    playlist: 'M4 6h11M4 11h11M4 16h6M18 16V7l3 1M18 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    rename: 'M4 20h16M5 15.5 15.5 5a2.1 2.1 0 0 1 3 3L8 18.5l-4 1z',
    chevron: 'M9 5l7 7-7 7',
    check: 'M4.5 12.5 9 17l10.5-10.5',
    filter: 'M4 6h16M7 12h10M10 18h4',
    close: 'M6 6l12 12M18 6 6 18',
    pin: 'M8 3h8v2h-1l1 6h1v2h-4v6h-2v-6H7v-2h1l1-6H8z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3.5 2',
    aura: 'M9.5 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M14.5 20.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11',
    discord:
        'M9 7.5C11 7 13 7 15 7.5L16.4 5.6 18.6 6.6C21.4 9.4 21.9 14 20.3 17.6L18.2 20 16.6 17.8C13.6 18.9 10.4 18.9 7.4 17.8L5.8 20 3.7 17.6C2.1 14 2.6 9.4 5.4 6.6L7.6 5.6ZM9.8 13.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6M14.2 13.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.5 20a7.5 7.5 0 0 1 15 0',
    star: 'M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z',
    upload: 'M12 15V4m0 0L8 8m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
}

// the shelf is the sidebar's own list. it holds the playlists, and whatever else
// is ticked keeps them company there - albums, artists, or both.
const SHELVES: { id: Shelf; label: string; icon: string }[] = [
    { id: 'playlists', label: 'Playlists', icon: ICONS.playlist },
    { id: 'albums', label: 'Albums', icon: ICONS.album },
    { id: 'artists', label: 'Artists', icon: ICONS.artist },
]

// a picked photo is almost never square, so it stops here on the way in: the
// window below is the circle the avatar will become, and the picture is
// dragged and zoomed behind it until the right part shows through
const CROP_VIEW = 248 // css px of the square crop window
const CROP_OUT = 512 // the square that is actually written back to the profile
const CROP_ZOOM = [1, 4] as const

type CropProps = {
    src: string
    busy: boolean
    // an avatar is a circle and a sleeve is a square: the window and the crop
    // are the same either way, and only the guide painted over them changes
    shape: 'round' | 'square'
    title: string
    on_cancel: () => void
    on_done: (data_url: string) => void
}

function CropDialog({ src, busy, shape, title, on_cancel, on_done }: CropProps) {
    const [natural, set_natural] = useState<{ w: number; h: number } | null>(null)
    const [zoom, set_zoom] = useState(1)
    const [offset, set_offset] = useState({ x: 0, y: 0 })
    const img_ref = useRef<HTMLImageElement>(null)
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

    // whichever way the picture is long, it covers the window at zoom 1
    const base = natural ? CROP_VIEW / Math.min(natural.w, natural.h) : 1
    const shown = natural
        ? { w: natural.w * base * zoom, h: natural.h * base * zoom }
        : { w: 0, h: 0 }

    // it may never uncover a corner: the offsets stay inside whatever slack the
    // picture has over the window at this zoom
    const hold = (x: number, y: number, w: number, h: number) => ({
        x: Math.min(0, Math.max(CROP_VIEW - w, x)),
        y: Math.min(0, Math.max(CROP_VIEW - h, y)),
    })

    function measure(e: React.SyntheticEvent<HTMLImageElement>) {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget
        const fit = CROP_VIEW / Math.min(w, h)

        set_natural({ w, h })
        set_zoom(1)
        set_offset({ x: (CROP_VIEW - w * fit) / 2, y: (CROP_VIEW - h * fit) / 2 })
    }

    // zooming pulls towards the middle of the window rather than its top left,
    // so whatever was framed stays framed
    function rezoom(next: number) {
        if (!natural) return

        const step = next / zoom
        const grown = { w: natural.w * base * next, h: natural.h * base * next }
        const middle = CROP_VIEW / 2

        set_zoom(next)
        set_offset((o) =>
            hold(middle - (middle - o.x) * step, middle - (middle - o.y) * step, grown.w, grown.h),
        )
    }

    function grab(e: React.PointerEvent) {
        if (!natural || busy) return

        drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
        e.currentTarget.setPointerCapture(e.pointerId)
    }

    function move(e: React.PointerEvent) {
        const from = drag.current
        if (!from) return

        set_offset(
            hold(
                from.ox + (e.clientX - from.x),
                from.oy + (e.clientY - from.y),
                shown.w,
                shown.h,
            ),
        )
    }

    // the window is square and the drawn square is square, so one drawImage
    // with the source rectangle the offsets describe is the whole crop
    function commit() {
        const image = img_ref.current
        const canvas = document.createElement('canvas')
        canvas.width = CROP_OUT
        canvas.height = CROP_OUT

        const ctx = canvas.getContext('2d')
        if (!image || !natural || !ctx) return

        const factor = base * zoom
        const side = CROP_VIEW / factor

        // jpeg has no alpha, so a transparent png would come out on black
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, CROP_OUT, CROP_OUT)
        ctx.drawImage(
            image,
            -offset.x / factor,
            -offset.y / factor,
            side,
            side,
            0,
            0,
            CROP_OUT,
            CROP_OUT,
        )

        on_done(canvas.toDataURL('image/jpeg', 0.92))
    }

    return (
        <div className='overlay crop-overlay' onClick={busy ? undefined : on_cancel}>
            <div className='dialog crop-dialog' onClick={(e) => e.stopPropagation()}>
                <div className='dialog-head'>
                    <h3>{title}</h3>
                    <button
                        className='icon-btn tiny'
                        {...tip('Close')}
                        disabled={busy}
                        onClick={on_cancel}
                    >
                        <Icon d={ICONS.close} size={15} />
                    </button>
                </div>

                <div
                    className='crop-view'
                    style={{ width: CROP_VIEW, height: CROP_VIEW }}
                    onPointerDown={grab}
                    onPointerMove={move}
                    onPointerUp={() => (drag.current = null)}
                    onPointerCancel={() => (drag.current = null)}
                    onWheel={(e) =>
                        rezoom(clamp(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), CROP_ZOOM))
                    }
                >
                    <img
                        ref={img_ref}
                        className='crop-img'
                        src={src}
                        alt=''
                        draggable={false}
                        onLoad={measure}
                        style={{
                            width: shown.w,
                            height: shown.h,
                            transform: `translate(${offset.x}px, ${offset.y}px)`,
                        }}
                    />
                    {/* the guide is only a guide - it is painted over the
                        picture and takes no clicks, so the drag underneath it
                        keeps working across the whole window */}
                    <div className={`crop-ring ${shape}`} />
                </div>

                <input
                    className='slider'
                    type='range'
                    min={CROP_ZOOM[0]}
                    max={CROP_ZOOM[1]}
                    step={0.01}
                    value={zoom}
                    disabled={!natural || busy}
                    aria-label='Zoom'
                    onChange={(e) => rezoom(Number(e.currentTarget.value))}
                />

                <p className='crop-hint'>Drag the photo to move it, and the slider to zoom.</p>

                <div className='dialog-actions'>
                    <button className='pill-btn' disabled={busy} onClick={on_cancel}>
                        Cancel
                    </button>
                    <button
                        className='pill-btn primary'
                        disabled={!natural || busy}
                        onClick={commit}
                    >
                        {busy ? <span className='spinner' /> : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default function App() {
    // read once, off the last tick the previous run wrote
    const saved_playback = useMemo(stored_playback, [])

    const [theme, set_theme] = useState<Theme>(() => stored_pref('theme', THEMES, 'system'))
    // the switch, and how much of the cover reaches the background while it is on:
    // 0 leaves a scrim over nearly all of it, 100 is the artwork with none at all
    const [aura_on, set_aura_on] = useState(() => stored_flag('aura_on', true))
    const [aura, set_aura] = useState(() => stored_number('aura', 50, AURA_RANGE))
    const [aura_menu, set_aura_menu] = useState<{ x: number; y: number } | null>(null)
    const [share_dc, set_share_dc] = useState(() => stored_flag('share_dc', true))
    const [view, set_view] = useState<View>(saved_playback?.view ?? 'library')
    const [selection, set_selection] = useState<string | null>(saved_playback?.selection ?? null)

    // the profile popup and the page it opens into - kept apart from `view`,
    // which is the library's own switch and already carries a lot of meaning
    const [username, set_username] = useState('')
    const [profile_pic, set_profile_pic] = useState('')
    const [biography, set_biography] = useState('')
    const [favorites, set_favorites] = useState<FavoriteTrack[]>([])
    const [profile_open, set_profile_open] = useState(false)
    const [profile_edit_open, set_profile_edit_open] = useState(false)
    const [username_draft, set_username_draft] = useState('')
    const [bio_draft, set_bio_draft] = useState('')
    const [crop_busy, set_crop_busy] = useState(false)
    // the photo waiting to be cropped, held as a data url while the window is
    // up, and what it is being cropped for: the profile, or a playlist by name
    const [crop_src, set_crop_src] = useState('')
    const [crop_for, set_crop_for] = useState<{ kind: 'avatar' } | { kind: 'playlist'; name: string }>(
        { kind: 'avatar' },
    )

    const [volume, set_volume_state] = useState(1)
    // what unmuting goes back to, so the level survives a trip through zero
    const [prev_volume, set_prev_volume] = useState(1)
    const [volume_menu, set_volume_menu] = useState<{ x: number; y: number } | null>(null)

    const [songs, set_songs] = useState<string[]>([])
    const [metadata_map, set_metadata_map] = useState<Record<string, string[]>>({})
    const [covers_map, set_covers_map] = useState<Record<string, string>>({})
    const [liked, set_liked] = useState<Set<string>>(new Set())
    const [loading, set_loading] = useState(false)
    const [music_folder, set_music_folder] = useState('')
    const [scan_error, set_scan_error] = useState<string | null>(null)

    const [current, set_current] = useState<string | null>(null)
    const [paused, set_paused] = useState(false)
    const [looped, set_looped] = useState(false)
    const [length, set_length] = useState(0)
    const [position, set_position] = useState(0)
    const [seeking, set_seeking] = useState<number | null>(null)
    const [shuffle_mode, set_shuffle_mode] = useState<Shuffle>(saved_playback?.shuffle ?? 'off')
    // the order itself, kept apart from the mode: it is dealt once, by a click,
    // and then it is the queue until something asks for another one
    const [shuffled, set_shuffled] = useState<string[] | null>(null)
    const [shuffle_menu, set_shuffle_menu] = useState<{ x: number; y: number } | null>(null)

    // the sheet for one track: whatever lrclib returned for it, '' included. it
    // is not a cache - lyrics.json on the far side is - so it holds the track it
    // belongs to, and a sheet whose track is no longer the one playing is a
    // sheet that has not come back yet.
    const [sheet_for, set_sheet_for] = useState<{ song: string; text: string } | null>(null)

    // the card the player bar opens into. what last.fm keeps on the track is held
    // exactly the way the sheet is - by the track it belongs to - so an answer
    // that lands after the song has changed is not read as this one's.
    const [info_for, set_info_for] = useState<{ song: string; info: TrackInfo | null } | null>(
        null,
    )
    const [info_open, set_info_open] = useState(false)
    // the card's own 'add to', anchored under the button rather than at a cursor
    const [info_menu, set_info_menu] = useState<{ x: number; bottom: number } | null>(null)
    // the card has two faces and the sheet is the one worth turning to
    const [info_face, set_info_face] = useState<'about' | 'lyrics'>('about')

    const [menu, set_menu] = useState<Menu | null>(null)
    const [submenu, set_submenu] = useState(false)
    const [filters, set_filters] = useState(false)

    const [sort, set_sort] = useState<Sort>(() =>
        stored_pref('sort', SORTS.map((s) => s.id), 'title'),
    )
    // one layout per kind of listing, each starting where that listing has always
    // opened: covers for the library and the liked songs, a list for a playlist,
    // and the plain rows an album or an artist has always come up as
    const [layouts, set_layouts] = useState<Record<LayoutKey, Layout>>(() => {
        const ids = LAYOUTS.map((option) => option.id)

        return {
            library: stored_pref(LAYOUT_PREFS.library, ids, 'grid'),
            liked: stored_pref(LAYOUT_PREFS.liked, ids, 'grid'),
            playlist: stored_pref(LAYOUT_PREFS.playlist, ids, 'list'),
            group: stored_pref(LAYOUT_PREFS.group, ids, 'compact'),
        }
    })
    const [dialog, set_dialog] = useState<Dialog | null>(null)
    const [draft, set_draft] = useState('')

    // name -> its tracks, kept in sync with playlists.json
    const [playlists, set_playlists] = useState<Record<string, string[]>>({})
    // name -> the sleeve it was given, for the ones that have been given one
    const [playlist_covers, set_playlist_covers] = useState<Record<string, string>>({})
    const [pins, set_pins] = useState<string[]>(stored_pins)

    const [library_menu, set_library_menu] = useState<{ x: number; y: number } | null>(null)
    // which kinds keep the playlists company in the sidebar list
    const [shelves, set_shelves] = useState<Shelf[]>(stored_shelves)
    const [library_view, set_library_view] = useState<LibraryView>(() =>
        stored_pref('library_view', LIBRARY_VIEWS.map((o) => o.id), 'list'),
    )

    // column widths are percentages of the frame, so they follow every window resize
    const [sidebar_w, set_sidebar_w] = useState(() => stored_width('sidebar', 13, SIDEBAR_RANGE))
    const [rail_w, set_rail_w] = useState(() => stored_width('rail', 17, RAIL_RANGE))
    const frame = useRef<HTMLDivElement>(null)
    const [frame_w, set_frame_w] = useState(0)

    const [sidebar_hidden, set_sidebar_hidden] = useState(() => stored_flag('sidebar_hidden', false))
    const [rail_hidden, set_rail_hidden] = useState(() => stored_flag('rail_hidden', false))
    const resizing = useRef<{
        edge: 'sidebar' | 'rail'
        from: number
        width: number
        latest: number
    } | null>(null)

    // the sliding indicator behind whichever library row is open. the fixed rows
    // and the scrolling list below the chips each get one: a single element cannot
    // travel between two scroll regions without leaving one of them.
    const nav_pill = useRef<HTMLDivElement>(null)
    const shelf_pill = useRef<HTMLDivElement>(null)
    const sidebar_ref = useRef<HTMLElement>(null)
    const shelf_ref = useRef<HTMLDivElement>(null)

    const [query, set_query] = useState('')
    const [searching, set_searching] = useState(false)
    const [results, set_results] = useState<SearchResult[]>([])
    // how much of the answer is on screen - every list that arrives starts at one
    // page, and 'load more' walks it up from there
    const [shown, set_shown] = useState(PAGE)
    // a search shells out to yt-dlp, and the two sources are tabs over the same
    // query - flipping between them should not pay for it twice. the request is
    // held alongside its answer so a tab left and returned to before it lands
    // waits on the one already running instead of starting another.
    const searches = useRef(
        new Map<string, { pending: Promise<SearchResult[]>; found?: SearchResult[] }>(),
    )
    // switching tabs mid-flight leaves an answer in the air, and it must not land
    // on top of the newer one
    const search_run = useRef(0)
    // the refs currently being fetched: several at once is fine, and a row only
    // answers for itself
    const [downloading, set_downloading] = useState<string[]>([])
    const [source, set_source] = useState<Source>('yt')
    const [search_open, set_search_open] = useState(false)

    // a pass costs one request per seed, so what it turned up is kept until the
    // refresh button asks for another one
    const [similar, set_similar] = useState<Suggestion[]>([])
    const [similar_busy, set_similar_busy] = useState(false)
    const [cards_shown, set_cards_shown] = useState(SUGGESTION_PAGE)
    // a pass left in the air must not land on top of the one that replaced it
    const similar_run = useRef(0)
    const asked_similar = useRef(false)
    // everything the shelf has already offered this session. another pass reads
    // it as a list of what not to come back with, which is what makes the
    // button worth pressing twice.
    const served = useRef(new Set<string>())
    // how the shelf is read, and the menu that changes it. it is the
    // suggestions' own setting - the shelves above keep theirs.
    const [suggestion_view, set_suggestion_view] = useState<SuggestionView>(() =>
        stored_pref(
            'suggestion_view',
            SUGGESTION_VIEWS.map((option) => option.id),
            'grid',
        ),
    )
    const [suggestion_menu, set_suggestion_menu] = useState(false)

    // the same shelf again, at the foot of a playlist or the liked songs, drawn
    // from what is in that listing. it belongs to the listing rather than to
    // the session, so nearby_for is what it is currently holding.
    const [nearby, set_nearby] = useState<Suggestion[]>([])
    const [nearby_busy, set_nearby_busy] = useState(false)
    const [nearby_shown, set_nearby_shown] = useState(NEARBY_PAGE)
    const nearby_run = useRef(0)
    // which listing's shelf is the one on screen
    const nearby_for = useRef('')

    /*
     * What every listing's shelf is holding, kept behind the one on screen.
     * A pass is a round trip per seed, and walking out of a playlist and back
     * into it does not change what is in the playlist - so it should not cost
     * another one, and should not answer with the same names as if they were
     * new. Each listing keeps its tracks, how far down it had been uncovered,
     * and what it has already offered.
     */
    const nearby_cache = useRef(
        new Map<string, { tracks: Suggestion[]; shown: number; served: Set<string> }>(),
    )

    const nearby_memory = (key: string) => {
        const held = nearby_cache.current.get(key)

        if (held) return held

        const fresh = { tracks: [] as Suggestion[], shown: NEARBY_PAGE, served: new Set<string>() }
        nearby_cache.current.set(key, fresh)

        return fresh
    }

    // which listing the shelf belongs to, and the only two that get one: a
    // playlist and the liked songs are hand-picked, so they are the two
    // listings where 'what else is like this' means anything
    const nearby_key =
        view === 'playlist' && selection
            ? `playlist:${selection}`
            : view === 'liked'
              ? 'liked'
              : ''
    // suggestions being fetched, the ones that came in, and the ones youtube had
    // nothing for. all keyed by the suggestion, so a card answers for itself.
    // 'fetched' is kept because a download is named after the search result
    // rather than the suggestion, and the two names do not always fold together
    // - the card would otherwise still be offering what it just brought in.
    const [getting, set_getting] = useState<string[]>([])
    const [fetched, set_fetched] = useState<string[]>([])
    const [missing, set_missing] = useState<string[]>([])


    useEffect(() => {
        const element = frame.current
        if (!element) return

        const observer = new ResizeObserver(([entry]) =>
            set_frame_w(entry.contentRect.width),
        )

        observer.observe(element)

        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        document.documentElement.style.setProperty('--aura', `${aura / 100}`)
    }, [aura])

    useEffect(() => {
        if (!shuffle_menu) return

        const close = () => set_shuffle_menu(null)

        window.addEventListener('click', close)
        window.addEventListener('resize', close)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
        }
    }, [shuffle_menu])

    useEffect(() => {
        if (!volume_menu) return

        const close = () => set_volume_menu(null)
        const on_key = (e: KeyboardEvent) => e.key === 'Escape' && close()

        window.addEventListener('click', close)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', on_key)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
            window.removeEventListener('keydown', on_key)
        }
    }, [volume_menu])

    useEffect(() => {
        if (!aura_menu) return

        const close = () => set_aura_menu(null)
        const on_key = (e: KeyboardEvent) => e.key === 'Escape' && close()

        window.addEventListener('click', close)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', on_key)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
            window.removeEventListener('keydown', on_key)
        }
    }, [aura_menu])

    // the favourites list is only worth fetching once the page that shows it
    // is actually open
    useEffect(() => {
        if (profile_open) load_favorites()
    }, [profile_open])

    useEffect(() => {
        // with no attribute the stylesheet falls back to prefers-color-scheme
        if (theme === 'system') delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = theme
    }, [theme])

    // the cover of the current track drives --art-h/--art-s, which every accent
    // in the stylesheet is mixed from. no cover means the app stays monochrome.
    const current_cover = current ? covers_map[current] : undefined

    useEffect(() => {
        const root = document.documentElement

        if (!current_cover) {
            root.style.removeProperty('--art-h')
            root.style.removeProperty('--art-s')
            return
        }

        let cancelled = false

        art_accent(current_cover).then((accent) => {
            if (cancelled || !accent) return

            root.style.setProperty('--art-h', `${accent[0]}`)
            root.style.setProperty('--art-s', `${accent[1]}%`)
        })

        return () => {
            cancelled = true
        }
    }, [current_cover])

    const ambient = useCrossfade(aura_on ? current_cover : undefined)

    // asked for every track that comes up, and no longer asked once per session:
    // the backend keeps lyrics.json and answers off disk, which is the copy that
    // outlives the window
    useEffect(() => {
        if (!current) return

        const song = current
        const ask = asked(title_of(song), artist_of(song))
        let cancelled = false

        bridge()
            .get_lyrics(ask.track, ask.artist)
            .then((raw) => !cancelled && set_sheet_for({ song, text: raw ?? '' }))
            .catch(() => !cancelled && set_sheet_for({ song, text: '' }))

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- metadata_map feeds the two titles
    }, [current, metadata_map])

    // only while the card is up. nothing else on screen reads any of this, and
    // asking for every track that comes up would be a request per track nobody
    // opened - info.json on the far side is what makes the second look free.
    useEffect(() => {
        if (!info_open || !current) return

        const song = current
        const ask = asked(title_of(song), artist_of(song))
        let cancelled = false

        bridge()
            .get_info(ask.artist, ask.track)
            .then((raw) => !cancelled && set_info_for({ song, info: as_info(raw ?? '') }))
            .catch(() => !cancelled && set_info_for({ song, info: null }))

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- metadata_map feeds the two names
    }, [info_open, current, metadata_map])

    // the overlay takes the click that closes it, so escape is all that is left.
    // the list of playlists is a menu, though, and a menu closes on both.
    useEffect(() => {
        if (!info_open) return

        const on_key = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return

            if (info_menu) set_info_menu(null)
            else close_info()
        }

        window.addEventListener('keydown', on_key)

        return () => window.removeEventListener('keydown', on_key)
    }, [info_open, info_menu])

    useEffect(() => {
        if (!info_menu) return

        const close = () => set_info_menu(null)

        window.addEventListener('click', close)
        window.addEventListener('resize', close)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
        }
    }, [info_menu])


    const active_tip = useTip()
    const tip_box = useRef<HTMLDivElement>(null)

    // measured after it renders, so a tooltip on a button near either edge slides
    // back into the window instead of hanging off it
    useLayoutEffect(() => {
        const box = tip_box.current
        if (!box || !active_tip) return

        const half = box.getBoundingClientRect().width / 2
        const margin = 8

        box.style.left = `${Math.min(
            Math.max(active_tip.x, half + margin),
            window.innerWidth - half - margin,
        )}px`
    }, [active_tip])

    useEffect(() => {
        if (!search_open) return

        const close = () => set_search_open(false)
        const on_key = (e: KeyboardEvent) => e.key === 'Escape' && close()

        window.addEventListener('click', close)
        window.addEventListener('keydown', on_key)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('keydown', on_key)
        }
    }, [search_open])

    useEffect(() => {
        if (!library_menu) return

        const close = () => set_library_menu(null)

        window.addEventListener('click', close)
        window.addEventListener('resize', close)
        // it is pinned to the viewport, so a scrolling sidebar would leave it behind
        document.addEventListener('scroll', close, true)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
            document.removeEventListener('scroll', close, true)
        }
    }, [library_menu])

    useEffect(() => {
        if (!filters) return

        const close = () => set_filters(false)

        window.addEventListener('click', close)
        window.addEventListener('resize', close)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
        }
    }, [filters])

    // the suggestions' own view menu, closed the same way the sort menu is
    useEffect(() => {
        if (!suggestion_menu) return

        const close = () => set_suggestion_menu(false)

        window.addEventListener('click', close)
        window.addEventListener('resize', close)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
        }
    }, [suggestion_menu])

    useEffect(() => {
        if (!menu) return

        const close = () => set_menu(null)
        const on_key = (e: KeyboardEvent) => e.key === 'Escape' && close()

        window.addEventListener('click', close)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', on_key)
        document.addEventListener('scroll', close, true)

        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('resize', close)
            window.removeEventListener('keydown', on_key)
            document.removeEventListener('scroll', close, true)
        }
    }, [menu])

    useEffect(() => {
        void (async () => {
            const [library, lists] = await Promise.all([fetch_songs(), sync_playlists()])
            sync_liked()
            sync_profile()
            load_favorites()

            // the listing that was open last time may not have survived: a
            // playlist that was deleted, an album whose files left the folder
            const opened = saved_playback?.selection
            if (!opened) return

            const tag = saved_playback.view === 'artists' ? artist_tag : album_tag
            const alive =
                saved_playback.view === 'playlist'
                    ? !!lists?.[opened]
                    : library.names.some((name) => group_key(tag(library.metadata[name])) === opened)

            if (alive) return

            set_view('library')
            set_selection(null)
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the way up
    }, [])

    // the flag is a ui preference like the theme or the tint, so it lives in
    // localStorage and the backend is simply told what it is on the way up. its
    // own copy starts every launch at `on` and is never written anywhere, so
    // get_activity has nothing to say here that this side does not already know.
    useEffect(() => {
        bridge().set_activity(share_dc)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the stored value, once
    }, [])

    useEffect(() => {
        music_dir().then(set_music_folder)
    }, [])

    useEffect(() => {
        bridge().load_volume().then((v) => {
            set_volume_state(v)
            if (v > 0) set_prev_volume(v)
        })
    }, [])

    // kept in a ref so the poller below never has to be torn down and rebuilt
    const advance = useRef(() => {})

    useEffect(() => {
        const interval = setInterval(async () => {
            set_position(await bridge().get_position())
            set_length(await bridge().get_length())

            if (await bridge().is_finished()) advance.current()
        }, 1000)

        return () => clearInterval(interval)
    }, [])

    /*
     * Bringing the last track back. Nothing is loaded at startup and the backend
     * has no way to load a sound without starting it, so it is played and then
     * stopped again - stop() is a pause, the cursor survives it, and seek() only
     * wants a loaded sound, not a running one. What leaks out is one ipc round
     * trip of audio.
     */
    const restored = useRef(false)

    useEffect(() => {
        // the listing landing is the cue: the file has to still be on disk, and
        // the tags have to be in hand for the discord status
        if (restored.current || current || !songs.length) return

        restored.current = true

        if (!saved_playback || !songs.includes(saved_playback.song)) return

        const { song, position: saved_position } = saved_playback

        void (async () => {
            const meta = metadata_map[song] ?? []

            await bridge().play_music(
                (await music_dir()) + song,
                meta[0] || song,
                meta[1] || '',
                meta[2] || '',
            )
            await bridge().stop()

            const len = await bridge().get_length()

            // a cursor parked at the end trips is_finished, and the queue would
            // move on the moment the track is resumed
            const at = saved_position < len - 2 ? saved_position : 0
            if (at) await bridge().seek(at)

            set_current(song)
            set_paused(true)
            set_length(len)
            set_position(at)
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the rest is read once, on the cue
    }, [songs])

    // the other half of the restore: see PLAYBACK_KEY. position moves once a
    // second while a track runs, so that is how often this writes
    useEffect(() => {
        if (!current) return

        save_playback({ song: current, position, view, selection, shuffle: shuffle_mode })
    }, [current, position, view, selection, shuffle_mode])

    async function fetch_songs() {
        set_loading(true)

        // anything in here can throw - an old backend with no get_music_dir
        // binding, a music folder that is not there - and without the catch the
        // spinner below simply never stops, which says nothing about why
        try {
            const dir = await music_dir()
            const names: string[] = await bridge().fetch_songs(dir)

            const metadata: Record<string, string[]> = {}
            const covers: Record<string, string> = {}

            for (const name of names) {
                metadata[name] = await bridge().get_metadata(dir + name)
                covers[name] = await bridge().get_cover(dir + name)
            }

            set_songs(names)
            set_metadata_map(metadata)
            set_covers_map(covers)
            set_scan_error(null)

            return { names, metadata }
        } catch (e) {
            set_scan_error(e instanceof Error ? e.message : String(e))
            set_songs([])
            return { names: [] as string[], metadata: {} as Record<string, string[]> }
        } finally {
            set_loading(false)
        }
    }

    // liked_songs.json is the source of truth, so read it back after every write
    async function sync_liked() {
        try {
            set_liked(new Set(await bridge().get_liked_songs()))
        } catch {
            // keep showing whatever we have rather than dropping the list
        }
    }

    // profile.json backs all three, so one round trip covers the popup and the
    // page it opens into. each field fails on its own: a backend that only
    // exposes some of the profile bridge should still show what it has
    async function sync_profile() {
        const [name, pic, bio] = await Promise.all([
            bridge().get_username().catch(() => ''),
            bridge().get_profile_picture().catch(() => ''),
            bridge().get_biography().catch(() => ''),
        ])

        set_username(name)
        set_profile_pic(pic)
        set_biography(bio)
    }

    async function load_favorites() {
        try {
            set_favorites(await bridge().get_favorite_songs())
        } catch {
            set_favorites([])
        }
    }

    const is_favorite = (name: string) => favorites.some((track) => track.file_path === name)

    async function toggle_favorite(name: string) {
        const was_favorite = is_favorite(name)

        // flip right away so the click always gives feedback, then reconcile
        set_favorites((prev) =>
            was_favorite
                ? prev.filter((track) => track.file_path !== name)
                : [
                      ...prev,
                      {
                          title: title_of(name),
                          artist: artist_of(name),
                          album: album_of(name),
                          file_path: name,
                      },
                  ],
        )

        try {
            if (was_favorite) await bridge().remove_from_favorites(name)
            else
                await bridge().add_favorite_song({
                    title: title_of(name),
                    artist: artist_of(name),
                    album: album_of(name),
                    file_path: name,
                })
        } finally {
            await load_favorites()
        }
    }

    async function toggle_like(name: string) {
        const was_liked = liked.has(name)

        // flip right away so the click always gives feedback, then reconcile
        set_liked((prev) => {
            const next = new Set(prev)

            if (was_liked) next.delete(name)
            else next.add(name)

            return next
        })

        try {
            if (was_liked) await bridge().unlike_song(name)
            else await bridge().like_song(name)
        } finally {
            await sync_liked()
        }
    }

    // playlists.json is small, so the whole thing is pulled in one go - sleeves
    // included. a backend without the cover calls still answers for the tracks,
    // so each sleeve fails on its own rather than taking the list down with it.
    async function sync_playlists() {
        try {
            const names = await bridge().get_playlists()
            const [tracks, sleeves] = await Promise.all([
                Promise.all(names.map((name) => bridge().get_playlist(name))),
                Promise.all(
                    names.map((name) => bridge().get_playlist_cover(name).catch(() => '')),
                ),
            ])

            const map = Object.fromEntries(names.map((name, i) => [name, tracks[i]]))

            set_playlists(map)
            set_playlist_covers(
                Object.fromEntries(names.map((name, i) => [name, sleeves[i]]).filter(([, art]) => art)),
            )

            return map
        } catch {
            // keep the last known list rather than blanking the sidebar
            return null
        }
    }

    // the backend counts the playlists, and the new one is named after that count.
    // a name already on the list means the count has been reused, so walk past it.
    async function next_playlist_name() {
        const taken = new Set(Object.keys(playlists))

        let count = taken.size

        try {
            count = await bridge().get_playlist_count()
        } catch {
            // the count is not exposed yet: the sidebar knows the same number
        }

        let name = `Playlist ${count}`
        while (taken.has(name)) name = `Playlist ${++count}`

        return name
    }

    // making one is not worth a question. it gets a name, it opens as if it had
    // been clicked, and the header's pencil is where a better name goes.
    async function new_playlist(song?: string) {
        const name = await next_playlist_name()

        await bridge().create_playlist(name)
        // started from a track: the point was to put that track somewhere new
        if (song) await bridge().add_to_playlist(name, song)

        await sync_playlists()
        open_playlist(name)
    }

    function toggle_pin(name: string) {
        const next = pins.includes(name) ? pins.filter((pin) => pin !== name) : [...pins, name]

        set_pins(next)
        save_pref('pins', next)
    }

    // a pin points at a name, so it has to follow renames and disappear with deletes
    function move_pin(name: string, renamed: string | null) {
        if (!pins.includes(name)) return

        const next = renamed
            ? pins.map((pin) => (pin === name ? renamed : pin))
            : pins.filter((pin) => pin !== name)

        set_pins(next)
        save_pref('pins', next)
    }

    async function rename_playlist(name: string, renamed: string) {
        const trimmed = renamed.trim()
        if (!trimmed || trimmed === name) return

        await bridge().rename_playlist(name, trimmed)
        await sync_playlists()

        move_pin(name, trimmed)

        // the open view is keyed by name, so follow the rename
        if (view === 'playlist' && selection === name) set_selection(trimmed)
    }

    async function delete_playlist(name: string) {
        await bridge().delete_playlist(name)
        await sync_playlists()

        move_pin(name, null)

        if (view === 'playlist' && selection === name) open_view('library')
    }

    async function add_to_playlist(playlist: string, name: string) {
        await bridge().add_to_playlist(playlist, name)
        await sync_playlists()
    }

    async function remove_from_playlist(playlist: string, name: string) {
        await bridge().remove_from_playlist(playlist, name)
        await sync_playlists()
    }

    async function remove_song(name: string) {
        await bridge().delete_song((await music_dir()) + name)

        if (current === name) set_current(null)

        // nothing cascades on the disk side, so drop the dangling entries here
        for (const [playlist, tracks] of Object.entries(playlists)) {
            if (tracks.includes(name)) await bridge().remove_from_playlist(playlist, name)
        }

        await fetch_songs()
        await sync_liked()
        await sync_playlists()
    }

    async function play_music(name: string) {
        // the tags travel with the call: the backend needs them for the discord
        // status and this side has already read them into metadata_map
        const meta = metadata_map[name] ?? []
        await bridge().play_music((await music_dir()) + name, meta[0] || name, meta[1] || "", meta[2] || "")
        set_current(name)
        set_paused(false)
    }

    function seek_target(e: React.PointerEvent<HTMLDivElement>) {
        const rect = e.currentTarget.getBoundingClientRect()
        const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)

        return ratio * length
    }

    function start_seek(e: React.PointerEvent<HTMLDivElement>) {
        if (!current || !length) return

        e.currentTarget.setPointerCapture(e.pointerId)
        set_seeking(seek_target(e))
    }

    function move_seek(e: React.PointerEvent<HTMLDivElement>) {
        if (seeking === null) return
        set_seeking(seek_target(e))
    }

    async function commit_seek(e: React.PointerEvent<HTMLDivElement>) {
        if (seeking === null) return

        const target = seek_target(e)

        await bridge().seek(target)

        // set it here so the bar does not snap back before the next poll
        set_position(target)
        set_seeking(null)

        mpris(() => bridge().mpris_seeked(target))
    }

    async function nudge(seconds: number) {
        if (!current || !length) return

        const target = Math.min(Math.max(position + seconds, 0), length)

        set_position(target)
        await bridge().seek(target)

        mpris(() => bridge().mpris_seeked(target))
    }

    async function toggle_pause() {
        if (!current) return

        if (paused) await bridge().resume()
        else await bridge().stop()

        set_paused(!paused)
    }

    async function toggle_loop() {
        await bridge().toggle_loop(!looped)
        set_looped(!looped)
    }

    function skip(offset: number) {
        if (!queue.length) return

        const index = current ? queue.indexOf(current) : -1
        play_music(queue[(index + offset + queue.length) % queue.length])
    }

    // one source's half of a search. an answer already on file comes straight
    // back, a request already in the air is waited on rather than doubled, and
    // whatever lands is filed before the caller sees it - so the tab this was
    // fetched for and the tab that asked for it both find it here later.
    function fetch_source(on: Source, wanted: string) {
        const key = `${on}\n${wanted}`
        const entry = searches.current.get(key)

        if (entry?.found) return Promise.resolve(entry.found)

        const pending = entry?.pending ?? run_search(on, wanted)
        if (!entry) searches.current.set(key, { pending })

        return pending.then((found) => {
            if (found.length) searches.current.set(key, { pending, found })
            // an empty answer is not worth remembering - the empty state invites
            // another enter, and that has to be able to actually go out
            else searches.current.delete(key)

            return found
        })
    }

    async function search(on: Source = source) {
        const wanted = query.trim()
        if (!wanted) return

        set_search_open(true)

        const run = ++search_run.current

        // both sources go out on the same enter. the tab that is not on screen
        // costs one more yt-dlp process now and, in return, switching to it is
        // instant instead of another wait - by then its answer is already filed
        for (const other of SOURCES) {
            if (other.id !== on) void fetch_source(other.id, wanted)
        }

        // already answered: the list swaps over with no round trip, and without
        // blanking out on the way
        const found_already = searches.current.get(`${on}\n${wanted}`)?.found
        if (found_already) {
            set_results(found_already)
            set_shown(PAGE)
            set_searching(false)
            return
        }

        set_results([])
        set_shown(PAGE)
        set_searching(true)

        const found = await fetch_source(on, wanted)

        // it is just not the list on screen any more
        if (run !== search_run.current) return

        set_results(found)
        set_shown(PAGE)
        set_searching(false)
    }

    const owned = useMemo(() => {
        const ids = new Set<string>()
        const titles = new Set<string>()

        for (const name of songs) {
            const { title, id } = library_mark(name)

            if (id) ids.add(id)
            titles.add(fold(title))
        }

        return { ids, titles }
    }, [songs])

    // youtube hands back the same id the file is named with, so that match is
    // exact. soundcloud hands back the page url instead and its bracketed id is
    // a number the search never prints, which leaves the title to go on.
    const owns = (result: SearchResult) =>
        owned.ids.has(result.ref) || owned.titles.has(fold(result.title))

    // soundcloud sends an artwork url, youtube's is built from the video id
    const artwork = (result: SearchResult) =>
        source === 'yt' ? `https://img.youtube.com/vi/${result.ref}/mqdefault.jpg` : result.thumbnail

    function switch_source(next: Source) {
        set_source(next)

        if (query.trim()) search(next)
        else {
            set_results([])
            set_shown(PAGE)
        }
    }

    // every binding runs on a thread of its own, so downloads do not have to take
    // turns: only the row being fetched is held, and the rest of the list stays live
    async function download(result: SearchResult) {
        // the row is disabled for both of these, but the click is not the only
        // way in and yt-dlp would happily fetch a second copy
        if (downloading.includes(result.ref) || owns(result)) return

        set_downloading((busy) => [...busy, result.ref])

        try {
            const dir = await music_dir()

            if (source === 'yt') await bridge().download_yt(result.ref, dir)
            else await bridge().download_sc(result.ref, dir)
        } finally {
            // a failed fetch has to let go of the row too, or it never comes back
            set_downloading((busy) => busy.filter((ref) => ref !== result.ref))
        }

        await fetch_songs()
        await sync_liked()
    }

    function open_playlist(name: string) {
        set_profile_open(false)
        set_view('playlist')
        set_selection(name)
    }

    function open_view(next: View) {
        set_profile_open(false)
        set_view(next)
        set_selection(null)
    }

    const title_of = (name: string) => metadata_map[name]?.[0] || name.replace(/\.mp3$/i, '')
    const artist_of = (name: string) => artist_tag(metadata_map[name])
    const album_of = (name: string) => album_tag(metadata_map[name])
    const cover_of = (name: string) => covers_map[name]
    const length_of = (name: string) => Number(metadata_map[name]?.[3]) || 0
    const added_of = (name: string) => Number(metadata_map[name]?.[4]) || 0

    // group the library by an id3 field, keeping the scan order
    function group_by(key: (name: string) => string) {
        const groups = new Map<string, string[]>()

        for (const name of songs) {
            const value = key(name).trim() || 'Unknown'
            const bucket = groups.get(value)

            if (bucket) bucket.push(name)
            else groups.set(value, [name])
        }

        return groups
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps -- both helpers read songs/metadata_map
    const albums = useMemo(() => group_by(album_of), [songs, metadata_map])
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const artists = useMemo(() => group_by(artist_of), [songs, metadata_map])

    const liked_songs = songs.filter((name) => liked.has(name))
    const groups = view === 'albums' ? albums : view === 'artists' ? artists : null

    // the library page is what has been marked, what has just arrived, and what
    // could come next - ten at a time, and no further. every other view is a
    // listing of tracks, and those are read the way they always were.
    const overview = view === 'library' && !selection

    /*
     * Suggestions. The backend answers about one track at a time - that is the
     * shape of the last.fm call behind it - so a pass picks a sample of the
     * tracks the listener has already marked and asks about each of them, a few
     * at a time. What comes back are tracks that are not here yet, which is why
     * a click on one goes to the search rather than to the player.
     */

    // what a suggestion is measured against: something already on disk is not
    // one. the tags and the file name both count - a download names the file
    // after the search result, which is where the tags may not have reached.
    const library_keys = useMemo(() => {
        const keys = new Set<string>()

        for (const name of songs) {
            keys.add(fold(artist_of(name) + title_of(name)))
            keys.add(fold(library_mark(name).title))
        }

        return keys
        // eslint-disable-next-line react-hooks/exhaustive-deps -- both helpers read metadata_map
    }, [songs, metadata_map])

    /*
     * What the shelf is drawn from, in two halves.
     *
     * 'marked' is everything the listener has pointed at - liked, favourited,
     * or put in a playlist by hand - and it is still where most of a pass goes.
     * 'rest' is the remainder of the folder: tracks nobody has said anything
     * about, which are just as much a part of the collection and never used to
     * get a say. A pass takes from both, so two runs over the same small pile
     * of hearts no longer come back with the same names.
     *
     * A favourite whose file has left the folder is in neither: the backend
     * reads the file to know what it is asking about.
     */
    const seed_pools = useMemo(() => {
        const on_disk = new Set(songs)
        const marked = new Set(songs.filter((name) => liked.has(name)))

        for (const track of favorites) {
            if (on_disk.has(track.file_path)) marked.add(track.file_path)
        }

        for (const tracks of Object.values(playlists)) {
            for (const name of tracks) if (on_disk.has(name)) marked.add(name)
        }

        return {
            marked: [...marked],
            rest: songs.filter((name) => !marked.has(name)),
        }
    }, [songs, liked, favorites, playlists])

    // one pass worth of seeds: mostly what has been marked, topped up from the
    // rest of the folder. with nothing marked at all the whole draw comes from
    // there, which is how a fresh library gets a shelf.
    function pick_seeds() {
        const { marked, rest } = seed_pools
        const wanted = between(SEEDS)
        const wide = Math.min(Math.round(wanted * WIDER_SHARE), rest.length)
        const close = sample(marked, wanted - wide)

        return [...close, ...sample(rest, wanted - close.length)]
    }

    /*
     * The shelf is filled rather than filtered. Last.fm hardly ever carries a
     * picture on the similar list itself - what it sends is one grey star for
     * everything - so nearly every suggestion costs a second request before it
     * can be shown, and a suggestion with no picture is not shown at all.
     *
     * So the candidates are walked in order of closeness, a few at a time, and
     * the walk stops the moment the shelf is full: whatever is left over would
     * have been another request for a card nobody scrolls to.
     */
    async function with_pictures(tracks: Suggestion[], wanted: number, alive: () => boolean) {
        const filled: Suggestion[] = []
        let next = 0

        await Promise.all(
            Array.from({ length: Math.min(LANES, tracks.length) }, async () => {
                while (filled.length < wanted && next < tracks.length && alive()) {
                    const track = tracks[next++]

                    const image =
                        track.image ||
                        picture(
                            as_cover(
                                await bridge()
                                    .get_info(track.artist, track.title)
                                    .catch(() => ''),
                            ),
                        )

                    if (image) filled.push({ ...track, image })
                }
            }),
        )

        // the lanes finish out of turn, so the order is put back afterwards
        return filled.sort((a, b) => b.match - a.match)
    }

    /*
     * One pass, wherever it was asked for.
     *
     * The seeds go out one at a time - that is the shape of the last.fm call
     * behind them - and what comes back is gathered into a single list, thinned
     * to what is not already on disk, held back from repeating what the shelf
     * has already offered, spread so no one artist takes it over, and finally
     * filled with pictures until there are enough to show.
     *
     * 'skip' is the shelf's memory of what it has served. It is cleared here
     * rather than by the caller: only this side knows whether holding those
     * back would have left the shelf half empty, and a repeat beats a gap.
     */
    async function gather(
        seeds: string[],
        wanted: number,
        skip: Set<string>,
        alive: () => boolean,
    ): Promise<Suggestion[]> {
        const dir = await music_dir()

        const answers = await in_lanes(seeds, LANES, (name) =>
            bridge()
                .get_similar(dir + name, between(PER_SEED))
                .then(as_similar)
                // no api key, no network, a track last.fm has never heard of:
                // all of them are a seed with nothing to say, and the pass
                // carries on with the ones that do
                .catch(() => [] as SimilarTrack[]),
        )

        if (!alive()) return []

        // the seeds are how the list is gathered, not how it is read: what comes
        // back is one list, and the same track answering for two seeds is still
        // one suggestion
        const seen = new Set<string>()
        const found: Suggestion[] = []

        for (const answer of answers) {
            for (const track of answer ?? []) {
                // parsed text rather than a typed answer: every field is
                // whatever last.fm happened to put there, including nothing
                const title = String(track?.name ?? '').trim()
                const artist = String(track?.artist ?? '').trim()

                if (!title) continue

                const key = fold(artist + title)
                if (seen.has(key) || library_keys.has(key)) continue

                seen.add(key)
                found.push({
                    key,
                    title,
                    artist,
                    image: picture(String(track?.image ?? '')),
                    // it is an order, not a label, and last.fm has sent it as
                    // text before now
                    match: Number(track?.match) || 0,
                })
            }
        }

        const unseen = found.filter((track) => !skip.has(track.key))
        const pool = unseen.length >= wanted ? unseen : found

        if (pool === found) skip.clear()

        // closest first, no artist taking over, and only as deep as the shelf
        // could ever need
        const candidates = spread_artists(pool.sort((a, b) => b.match - a.match)).slice(
            0,
            wanted * 4,
        )

        const shown = await with_pictures(candidates, wanted, alive)

        for (const track of shown) skip.add(track.key)

        return shown
    }

    // 'more' lands under what is on screen, and only the names that are not on
    // it already; the other two moods replace the shelf outright
    const settle = (mood: Mood, shown: Suggestion[]) => (current: Suggestion[]) => {
        if (mood !== 'more') return shown

        const here = new Set(current.map((track) => track.key))

        return [...current, ...shown.filter((track) => !here.has(track.key))]
    }

    /*
     * The library's own shelf, in one of three moods.
     *
     * 'new' is it being filled for the first time. 'again' is the pass button:
     * same kind of thing, deliberately not the same things - it draws new seeds
     * and refuses everything the shelf has already offered, so what comes back
     * is a different corner of the same taste. 'more' is the load button once
     * the cards run out: another dig, added under what is there.
     */
    async function load_similar(mood: Mood = 'new') {
        const { marked, rest } = seed_pools
        if (!marked.length && !rest.length) return
        if (similar_busy) return

        const run = ++similar_run.current

        asked_similar.current = true

        // a fresh shelf forgets what it has shown; the other two moods are the
        // ones that lean on it
        if (mood === 'new') served.current.clear()

        set_similar_busy(true)
        if (mood !== 'more') set_cards_shown(SUGGESTION_PAGE)

        try {
            const shown = await gather(
                pick_seeds(),
                SUGGESTIONS,
                served.current,
                () => run === similar_run.current,
            )

            // it is just not the pass on screen any more
            if (run !== similar_run.current) return

            set_similar(settle(mood, shown))

            if (mood === 'more') set_cards_shown((count) => count + SUGGESTION_PAGE)
        } finally {
            if (run === similar_run.current) set_similar_busy(false)
        }
    }

    /*
     * The shelf at the foot of a listing. Same pass, different seeds: what is
     * in the playlist you are standing in, or your liked songs, rather than
     * everything the library has to draw on. It belongs to that listing and is
     * thrown away when you leave it.
     */
    async function load_nearby(mood: Mood = 'new') {
        const key = nearby_key
        if (!key || !listed.length || nearby_busy) return

        const run = ++nearby_run.current
        const memory = nearby_memory(key)

        if (mood === 'new') memory.served.clear()

        set_nearby_busy(true)

        if (mood !== 'more') {
            memory.shown = NEARBY_PAGE
            set_nearby_shown(NEARBY_PAGE)
        }

        try {
            const shown = await gather(
                sample(listed, between(SEEDS)),
                NEARBY,
                memory.served,
                () => run === nearby_run.current && nearby_for.current === key,
            )

            if (run !== nearby_run.current) return

            memory.tracks = settle(mood, shown)(memory.tracks)
            set_nearby(memory.tracks)

            if (mood === 'more') {
                memory.shown += NEARBY_PAGE
                set_nearby_shown(memory.shown)
            }
        } finally {
            if (run === nearby_run.current) set_nearby_busy(false)
        }
    }

    function load_more_nearby() {
        if (nearby_shown < nearby.length) {
            const memory = nearby_memory(nearby_key)

            memory.shown = nearby_shown + NEARBY_PAGE
            set_nearby_shown(memory.shown)

            return
        }

        void load_nearby('more')
    }

    // the load button: more of what is already here first, and once that runs
    // out, another dig for names to put under it
    function load_more() {
        if (cards_shown < similar.length) {
            set_cards_shown(cards_shown + SUGGESTION_PAGE)
            return
        }

        void load_similar('more')
    }

    // the first pass waits until the library page is actually open: it is a
    // round trip per seed, and a launch straight into a playlist should not pay
    // for one. after that it stands until the refresh button asks again.
    useEffect(() => {
        if (asked_similar.current || profile_open || !overview) return
        if (!seed_pools.marked.length && !seed_pools.rest.length) return

        // started off the effect rather than in it: the pass sets nothing until
        // it has the music folder back, but a plain call here still reads as a
        // synchronous one
        void Promise.resolve().then(() => load_similar())
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the cue is the page and the seeds
    }, [profile_open, overview, seed_pools])

    const suggestion_name = (track: Suggestion) =>
        [track.artist, track.title].filter(Boolean).join(' - ')

    /*
     * A suggestion is a track that is not here yet, and unlike a search result
     * it carries no id to fetch by - only a name. So the name goes back out
     * through the same youtube search the box uses, and the first answer is
     * what gets downloaded. The menu is where this is asked for: a click that
     * quietly started a download would be the worst of both.
     */
    async function download_suggestion(track: Suggestion) {
        const here = library_keys.has(track.key) || fetched.includes(track.key)
        if (getting.includes(track.key) || here) return

        // where it was asked for is where it belongs: a suggestion taken from
        // the foot of a playlist joins that playlist, and one taken from the
        // liked songs is liked. read before the download rather than after -
        // the page can be somewhere else by the time yt-dlp is done.
        const home = nearby_key

        set_getting((busy) => [...busy, track.key])
        set_missing((gone) => gone.filter((key) => key !== track.key))

        try {
            const found = await fetch_source('yt', suggestion_name(track))
            const best = found.find((result) => !owns(result)) ?? found[0]

            // last.fm knows tracks youtube does not always carry, and a name
            // that turns up nothing is not an error - it is an answer
            if (!best) {
                set_missing((gone) => [...gone, track.key])
                return
            }

            await bridge().download_yt(best.ref, await music_dir())

            set_fetched((done) => [...done, track.key])

            // download_with_ytdlp names the file after the search result, id and
            // all, so the id is what says which of these is the one that landed
            const { names } = await fetch_songs()
            const landed = names.find((name) => library_mark(name).id === best.ref)

            if (landed && home.startsWith('playlist:')) {
                await add_to_playlist(home.slice('playlist:'.length), landed)
            } else if (landed && home === 'liked') {
                await bridge().like_song(landed)
            }

            await sync_liked()
        } catch {
            set_missing((gone) => [...gone, track.key])
        } finally {
            set_getting((busy) => busy.filter((key) => key !== track.key))
        }
    }

    // newest first for dates, alphabetical for the rest
    const by_sort = (a: string, b: string) =>
        sort === 'added'
            ? added_of(b) - added_of(a)
            : sort === 'artist'
              ? artist_of(a).localeCompare(artist_of(b))
              : sort === 'album'
                ? album_of(a).localeCompare(album_of(b))
                : title_of(a).localeCompare(title_of(b))

    // a playlist only lists what is still on disk
    const playlist_songs =
        view === 'playlist' && selection
            ? (playlists[selection] ?? []).filter((name) => songs.includes(name)).sort(by_sort)
            : []

    // the current queue: what prev/next walks through. every listing answers to
    // the sort, so the order on screen is the order it plays in.
    const listed =
        view === 'playlist'
            ? playlist_songs
            : selection
              ? [...(groups?.get(selection) ?? [])].sort(by_sort)
              : view === 'liked'
                ? [...liked_songs].sort(by_sort)
                : [...songs].sort(by_sort)

    /*
     * Sorting by album put the albums' tracks next to each other and left it at
     * that, so an artist read as one long run of songs with the album repeated
     * down a column. Sorted by album, a listing is the albums themselves - the
     * same cards the Albums page deals, and a click on one opens it.
     *
     * An album's own page is the one listing this cannot mean anything on: it
     * is already that album, and grouping it by album would be a page holding a
     * single card of itself. Everywhere else it holds, however few albums are
     * in it - a playlist of two tracks off the same record is still that record.
     */
    const album_runs = useMemo(() => {
        if (sort !== 'album') return null
        if (view === 'albums' && selection) return null

        const runs = new Map<string, string[]>()

        for (const name of listed) {
            const key = album_of(name) || 'Unknown album'
            const held = runs.get(key)

            if (held) held.push(name)
            else runs.set(key, [name])
        }

        return runs.size ? runs : null
        // eslint-disable-next-line react-hooks/exhaustive-deps -- album_of reads metadata_map
    }, [sort, view, selection, listed, metadata_map])

    /*
     * Which shelf is on screen. Walking into a listing that already has one
     * puts it back rather than asking for another - what is in the playlist has
     * not changed, so neither would the answer. Only a listing with no shelf yet
     * costs a pass, and an empty one costs nothing at all: it is left unclaimed
     * so that the first track added to it still gets a shelf.
     */
    useEffect(() => {
        if (!nearby_key || nearby_for.current === nearby_key) return

        const held = nearby_cache.current.get(nearby_key)

        if (held) {
            nearby_for.current = nearby_key
            set_nearby(held.tracks)
            set_nearby_shown(held.shown)

            return
        }

        set_nearby([])
        set_nearby_shown(NEARBY_PAGE)

        if (!listed.length) return

        nearby_for.current = nearby_key
        void Promise.resolve().then(() => load_nearby())
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the cue is the listing, and load_nearby reads it when it runs
    }, [nearby_key, listed.length])

    // anything that is a list of tracks is arranged by the menu: home, an album
    // or an artist opened up, a playlist, the liked songs. the album and artist
    // overviews are cards of groups rather than tracks, and the library page is
    // ten of this and ten of that, so none of those are.
    const tunable = (!groups || !!selection) && !overview

    // each of them remembers its own layout, because they are read differently -
    // a library is browsed by cover, a playlist is read down the list
    const layout_key: LayoutKey =
        view === 'playlist'
            ? 'playlist'
            : view === 'liked'
              ? 'liked'
              : selection
                ? 'group'
                : 'library'

    const layout = layouts[layout_key]

    function choose_layout(next: Layout) {
        set_layouts({ ...layouts, [layout_key]: next })
        save_pref(LAYOUT_PREFS[layout_key], next)
    }

    // the newest of what is here. files with no date on them cannot answer,
    // so the shelf goes away with them.
    const arrivals = useMemo(
        () =>
            songs
                .filter((name) => added_of(name))
                .sort((a, b) => added_of(b) - added_of(a))
                .slice(0, SHELF),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- added_of reads metadata_map
        [songs, metadata_map],
    )

    // how long it would take to hear all of it once. a file whose length never
    // came back counts as nothing rather than holding the sum up.
    const total_span = useMemo(
        () => songs.reduce((total, name) => total + length_of(name), 0),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- length_of reads metadata_map
        [songs, metadata_map],
    )

    // the same sum over whatever is on screen, for the head of a playlist
    const listed_span = useMemo(
        () => listed.reduce((total, name) => total + length_of(name), 0),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- length_of reads metadata_map
        [listed, metadata_map],
    )

    // a shelf is a row of covers, so it wants enough of them to read as one:
    // under four it is a gap with a heading on top, and the page is better off
    // without it. the suggestions go by the seeds instead - an empty folder is
    // the only case where the pass could only come back empty.
    const has_arrivals = overview && arrivals.length >= 4
    const has_more = overview && songs.length > 0

    const queue = shuffle_mode !== 'off' && shuffled?.length ? shuffled : listed

    /*
     * The order is dealt on the click and not a moment after. It used to be an
     * effect over the listing, which meant every playlist, album or artist you
     * opened threw the running order away and dealt another one - so shuffle
     * never got to the end of anything. Now it stands until it is asked again.
     */
    async function shuffle_into(mode: Shuffle) {
        set_shuffle_mode(mode)

        if (mode === 'off') {
            set_shuffled(null)
            return
        }

        // the backend owns the shuffling
        const pool = mode === 'all' ? songs : listed
        set_shuffled(await bridge().shuffle(pool))
    }

    /*
     * The head of a playlist plays that playlist, whatever the queue happens to
     * be holding from wherever it was dealt. On 'shuffle this listing' that
     * means dealing a fresh order over these tracks - pressing Play on a page
     * should not start somewhere else.
     */
    async function play_listing() {
        if (!listed.length) return

        if (shuffle_mode === 'listing') {
            const order = await bridge().shuffle(listed)

            set_shuffled(order)
            await play_music(order[0] ?? listed[0])

            return
        }

        await play_music(listed[0])
    }

    // off, then what is on screen, then everything, then off again
    const next_shuffle = (): Shuffle =>
        shuffle_mode === 'off' ? 'listing' : shuffle_mode === 'listing' ? 'all' : 'off'

    useEffect(() => {
        const on_key = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null

            // the search box keeps its keys
            if (target?.tagName === 'INPUT' || target?.isContentEditable) return
            if (e.ctrlKey || e.altKey || e.metaKey || !current) return

            if (e.code === 'Space') {
                // also stops the key from activating whichever button holds focus
                e.preventDefault()
                toggle_pause()
                return
            }

            if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
                e.preventDefault()
                nudge(e.code === 'ArrowRight' ? 10 : -10)
            }
        }

        window.addEventListener('keydown', on_key)

        return () => window.removeEventListener('keydown', on_key)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers read these directly
    }, [current, paused, position, length])

    // miniaudio parks the cursor at the end of a track, so is_finished drives the queue
    useEffect(() => {
        advance.current = () => {
            if (!current || paused || looped) return
            skip(1)
        }
    })

    /*
     * MPRIS - the interface every panel, shell dashboard, lock screen and media
     * key on the desktop reads a player through. Nothing outside the process can
     * see a note of what is playing without it, no matter what the window shows.
     *
     * The state is pushed from here rather than read out of the backend because
     * this is where it lives: SoundManager knows a sound is loaded but not
     * whether it is paused, and the queue, the tags and the artwork never leave
     * this side at all. Controls come back the other way through the ref below.
     */
    const controls = useRef<(cmd: string, arg: number) => void>(() => {})

    // rebuilt every render so the handler never reads a stale paused flag or a
    // queue from three tracks ago
    useEffect(() => {
        controls.current = (cmd, arg) => {
            if (cmd === 'playpause') toggle_pause()
            else if (cmd === 'play' && paused) toggle_pause()
            else if (cmd === 'pause' && !paused) toggle_pause()
            // there is no stopped state here - a track is always cued, so the
            // closest honest answer to Stop is a pause at the top of it
            else if (cmd === 'stop') {
                if (!paused) toggle_pause()
                seek_to(0)
            } else if (cmd === 'next') skip(1)
            else if (cmd === 'prev') skip(-1)
            else if (cmd === 'seek') seek_to(Math.min(Math.max(position + arg, 0), length))
            else if (cmd === 'position') seek_to(Math.min(Math.max(arg, 0), length))
            else if (cmd === 'volume') change_volume(arg)
            else if (cmd === 'loop') {
                if (arg > 0 !== looped) toggle_loop()
            } else if (cmd === 'shuffle') void shuffle_into(arg > 0 ? 'listing' : 'off')
        }
    })

    useEffect(() => {
        window.__yugen_mpris = (cmd, arg) => controls.current(cmd, arg)

        return () => {
            delete window.__yugen_mpris
        }
    }, [])

    // the cover rides along as the base64 the page already holds, so this is
    // kept to the track changing rather than the once a second below
    useEffect(() => {
        if (!current) {
            mpris(() => bridge().mpris_track('', '', '', '', ''))
            return
        }

        const name = current
        let cancelled = false

        void (async () => {
            const path = (await music_dir()) + name
            if (cancelled) return

            mpris(() =>
                bridge().mpris_track(
                    title_of(name),
                    artist_of(name),
                    album_of(name),
                    path,
                    covers_map[name] ?? '',
                ),
            )
        })()

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- metadata_map feeds the three tags
    }, [current, metadata_map, covers_map])

    // position is the one property mpris never signals, so this rides the poller
    // that already moves the progress bar and the backend only puts a signal on
    // the bus when something other than the position moved
    useEffect(() => {
        mpris(() =>
            bridge().mpris_state(
                !!current && !paused,
                position,
                length,
                volume,
                queue.length > 1,
                queue.length > 1,
                looped,
                shuffle_mode !== 'off',
            ),
        )
    }, [current, paused, position, length, volume, queue.length, looped, shuffle_mode])

    const up_next = current ? queue.slice(queue.indexOf(current) + 1).slice(0, 2) : []

    const NAV: { id: View; label: string; icon: string; count: number }[] = [
        {
            id: 'library',
            label: 'Library',
            icon: ICONS.library,
            count: songs.length,
        },
        {
            id: 'liked',
            label: 'Liked Songs',
            icon: ICONS.heart,
            count: liked_songs.length,
        },
        { id: 'albums', label: 'Albums', icon: ICONS.album, count: albums.size },
        {
            id: 'artists',
            label: 'Artists',
            icon: ICONS.artist,
            count: artists.size,
        },
    ]

    const frame_width = () => frame.current?.getBoundingClientRect().width || window.innerWidth

    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

    // measured against what main would get with the rail open, so toggling it cannot oscillate
    const room_for_rail = () => {
        if (!frame_w) return true

        const unit = rem()
        const gutter = 0.5 * unit
        const left = sidebar_hidden ? 0 : column_px(SIDEBAR_BOUNDS, sidebar_w, frame_w, unit)
        const right = column_px(RAIL_BOUNDS, rail_w, frame_w, unit)

        return frame_w - left - right - 2 * gutter >= MAIN_MIN * unit
    }

    const cramped = !room_for_rail()
    const sidebar_open = !sidebar_hidden
    const rail_open = !rail_hidden && !cramped

    function toggle_sidebar() {
        set_sidebar_hidden(!sidebar_hidden)
        save_pref('sidebar_hidden', !sidebar_hidden)
    }

    function toggle_rail() {
        set_rail_hidden(!rail_hidden)
        save_pref('rail_hidden', !rail_hidden)
    }

    const start_resize = (edge: 'sidebar' | 'rail') => (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.classList.add('active')
        frame.current?.classList.add('resizing')

        // the css clamp can be holding the column off its stored share, so start from
        // where the handle actually sits rather than from the stored number
        const bounds = frame.current!.getBoundingClientRect()
        const handle = e.currentTarget.getBoundingClientRect()
        const center = handle.left + handle.width / 2

        // the handle rides the middle of the gutter, the column edge is half a gutter back
        const gutter = parseFloat(getComputedStyle(frame.current!).columnGap) || 0
        const shown =
            (edge === 'sidebar' ? center - bounds.left : bounds.right - center) - gutter / 2

        const width = (shown / bounds.width) * 100

        resizing.current = { edge, from: e.clientX, width, latest: width }
    }

    function move_resize(e: React.PointerEvent<HTMLDivElement>) {
        const drag = resizing.current
        if (!drag) return

        // the rail grows leftwards, so its delta is inverted
        const delta = ((e.clientX - drag.from) / frame_width()) * 100
        const raw = drag.width + (drag.edge === 'sidebar' ? delta : -delta)

        if (drag.edge === 'sidebar') {
            drag.latest = clamp(raw, SIDEBAR_RANGE)
            set_sidebar_w(drag.latest)
        } else {
            drag.latest = clamp(raw, RAIL_RANGE)
            set_rail_w(drag.latest)
        }
    }

    const change_volume = (v: number) => {
        const clamped = Math.max(0, Math.min(1, v))
        set_volume_state(clamped)
        bridge().set_volume(clamped)
    }

    function end_resize(e: React.PointerEvent<HTMLDivElement>) {
        const drag = resizing.current

        e.currentTarget.classList.remove('active')
        frame.current?.classList.remove('resizing')
        resizing.current = null

        if (!drag) return

        // written once on release rather than on every move
        try {
            const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
            localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, [drag.edge]: drag.latest }))
        } catch {
            // storage unavailable, the width just will not stick
        }
    }

    // right-click target: the native webkit menu is off, this one replaces it
    const context = (target: MenuTarget) => (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        const height =
            target.kind === 'song'
                ? 230
                : target.kind === 'playlist'
                  ? 150
                  : target.kind === 'suggestion'
                    ? 120
                    : 70

        set_submenu(false)
        set_menu({
            ...target,
            x: Math.min(e.clientX, window.innerWidth - 220),
            y: Math.min(e.clientY, Math.max(window.innerHeight - height, 8)),
        })
    }

    const song_context = (name: string) => context({ kind: 'song', song: name })

    // it opens on what the track is rather than on where the last one was left:
    // the sheet is one button away, and this is a different song
    function open_info() {
        set_info_face('about')
        set_info_open(true)
    }

    // the menu hangs off the card and does not outlive it
    function close_info() {
        set_info_menu(null)
        set_info_open(false)
    }

    function open_dialog(next: Dialog) {
        set_draft(next.playlist)
        set_dialog(next)
    }

    async function commit_dialog() {
        if (!dialog) return

        set_dialog(null)
        await rename_playlist(dialog.playlist, draft)
    }

    // avatar, name and bio all live behind one "edit profile" dialog rather
    // than three separate inline affordances - the drafts are seeded fresh
    // every time it opens, so closing without saving never leaks a stale edit
    function open_profile_edit() {
        set_username_draft(username)
        set_bio_draft(biography)
        set_profile_edit_open(true)
    }

    async function commit_profile_edit() {
        const name = username_draft.trim()
        const bio = bio_draft.trim()
        set_profile_edit_open(false)

        if (name && name !== username) {
            set_username(name)
            try {
                await bridge().set_username(name)
            } catch {
                // the field already shows the new value; a failed write just
                // means it will not survive a restart
            }
        }

        if (bio !== biography) {
            set_biography(bio)
            try {
                await bridge().set_biography(bio)
            } catch {
                // ditto
            }
        }
    }

    // read straight into a data url: the webview's file input has no real
    // filesystem path to hand over (that is an old Electron-only extension,
    // not something WebKitGTK provides), so the bytes travel as base64 instead
    function read_as_data_url(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(file)
        })
    }

    // a picked file does not go straight to whatever asked for it: it opens the
    // crop window first, and only what is framed there is ever written
    async function pick_image(
        e: React.ChangeEvent<HTMLInputElement>,
        target: typeof crop_for,
    ) {
        const file = e.currentTarget.files?.[0]
        e.currentTarget.value = ''
        if (!file) return

        set_crop_for(target)
        set_crop_src(await read_as_data_url(file))
    }

    // a profile picture is stored as the whole data url - the mime type varies
    // and travels with it - but a cover is base64 on its own, the same as the
    // ones read off a file's tags, because that is what Cover puts back
    const raw_base64 = (data_url: string) => data_url.slice(data_url.indexOf(',') + 1)

    async function save_crop(data_url: string) {
        set_crop_busy(true)
        try {
            if (crop_for.kind === 'avatar') {
                const ok = await bridge().set_profile_picture(data_url)
                if (ok) set_profile_pic(await bridge().get_profile_picture())
            } else {
                const name = crop_for.name
                const ok = await bridge().set_playlist_cover(name, raw_base64(data_url))

                if (ok) {
                    // read back rather than trust the round trip: the backend
                    // is what the sidebar will be showing from here on
                    const saved = await bridge().get_playlist_cover(name)
                    set_playlist_covers((prev) => ({ ...prev, [name]: saved }))
                }
            }

            set_crop_src('')
        } finally {
            set_crop_busy(false)
        }
    }

    // local wrappers so call sites stay short
    const cover = (name: string, className: string) => (
        <Cover data={cover_of(name)} alt={title_of(name)} className={className} />
    )

    // an album's picture is its own and an artist's is a face. a playlist's may
    // be either: one it was given, or one borrowed off the first track inside
    // it. Either way it is the one row that carries a mark saying what it is,
    // tucked into the corner of the picture.
    const row_cover = (
        row: { kind: Shelf; name: string; art: string },
        className: string,
        size: number,
    ) =>
        row.kind === 'playlists' ? (
            <span className={`cover-mark ${className}-wrap`}>
                <Cover data={row.art} alt={row.name} className={className} />
                <span className='kind-mark' aria-hidden>
                    <Icon d={ICONS.playlist} size={size} />
                </span>
            </span>
        ) : (
            <Cover
                data={row.art}
                alt={row.name}
                className={`${className}${row.kind === 'artists' ? ' round' : ''}`}
            />
        )

    const heart = (name: string, className?: string, size?: number) => (
        <Heart
            liked={liked.has(name)}
            on_toggle={() => toggle_like(name)}
            className={className}
            size={size}
        />
    )

    // one search result. a download holds nothing but its own row, and 'held' is
    // marked with aria-disabled rather than the attribute: the tooltip is
    // delegated off pointer events, and a disabled button emits none of them
    function search_row(result: SearchResult) {
        const busy = downloading.includes(result.ref)
        const held = busy || owns(result)

        return (
            <button
                key={result.ref}
                className={`result${owns(result) ? ' owned' : ''}${busy ? ' busy' : ''}`}
                {...tip(
                    owns(result)
                        ? 'Already in your library'
                        : busy
                          ? 'Downloading...'
                          : 'Download',
                )}
                aria-disabled={held}
                onClick={() => !held && download(result)}
            >
                {artwork(result) ? (
                    <img src={artwork(result)} alt='' />
                ) : (
                    <div className='placeholder'>♪</div>
                )}
                <div className='result-meta'>
                    <div className='name ellipsis'>{result.title}</div>
                    <div className='muted'>
                        {owns(result)
                            ? 'In your library'
                            : busy
                              ? 'Downloading...'
                              : source === 'yt'
                                ? 'youtube'
                                : 'soundcloud'}
                    </div>
                </div>
                {owns(result) ? (
                    <Icon d={ICONS.check} size={15} />
                ) : busy ? (
                    <span className='spinner' />
                ) : (
                    <Icon d={ICONS.download} size={15} />
                )}
            </button>
        )
    }

    // the cover wall: what the library opens as, and what 'grid' picks elsewhere
    function track_cards(names: string[]) {
        return (
            <section className='card-row'>
                {names.map((name, i) => (
                    <div
                        key={name}
                        className='album'
                        style={{ '--i': i } as React.CSSProperties}
                        onClick={() => play_music(name)}
                        onContextMenu={song_context(name)}
                    >
                        {cover(name, 'album-cover')}
                        {heart(name)}
                        <div className='title ellipsis'>{title_of(name)}</div>
                        <div className='muted ellipsis'>{artist_of(name)}</div>
                    </div>
                ))}
            </section>
        )
    }

    function track_rows(names: string[]) {
        return (
            <div className='track-rows'>
                {names.map((name, i) => (
                    <div
                        key={name}
                        className='track'
                        onClick={() => play_music(name)}
                        onContextMenu={song_context(name)}
                    >
                        {current === name ? (
                            // the bars stand for a track that is running, so a
                            // paused one holds them where they are
                            <span className={`eq${paused ? ' still' : ''}`}>
                                <i />
                                <i />
                                <i />
                            </span>
                        ) : (
                            <span className='track-index'>{i + 1}</span>
                        )}
                        <div className='track-meta'>
                            <div className='name ellipsis'>{title_of(name)}</div>
                            <div className='muted ellipsis'>{artist_of(name)}</div>
                        </div>
                        {heart(name)}
                    </div>
                ))}
            </div>
        )
    }

    // the roomier playlist layout: cover, title/artist, album, added, length
    function track_list(names: string[]) {
        return (
            <div className='track-list'>
                {names.map((name) => (
                    <div
                        key={name}
                        className={`row${current === name ? ' playing' : ''}`}
                        onClick={() => play_music(name)}
                        onContextMenu={song_context(name)}
                    >
                        {cover(name, 'row-cover')}

                        <div className='track-meta'>
                            <div className='name ellipsis'>{title_of(name)}</div>
                            <div className='muted ellipsis'>{artist_of(name)}</div>
                        </div>

                        <div className='muted ellipsis row-album'>{album_of(name)}</div>
                        <div className='muted row-added'>{format_date(added_of(name))}</div>

                        {heart(name)}

                        <div className='muted row-length'>{format_time(length_of(name))}</div>
                    </div>
                ))}
            </div>
        )
    }

    // a group card: cover comes from the first track that actually has one
    function group_cards(
        entries: Map<string, string[]>,
        round?: boolean,
        open?: (name: string) => void,
    ) {
        return (
            <section className='card-row'>
                {[...entries].map(([name, tracks], i) => (
                    <div
                        key={name}
                        className='album'
                        style={{ '--i': i } as React.CSSProperties}
                        onClick={() => (open ? open(name) : set_selection(name))}
                    >
                        {cover(
                            tracks.find((track) => cover_of(track)) ?? tracks[0],
                            `album-cover${round ? ' round' : ''}`,
                        )}
                        <div className='title ellipsis'>{name}</div>
                        <div className='muted'>{tracks.length} tracks</div>
                    </div>
                ))}
            </section>
        )
    }

    /*
     * The same groups the Albums page deals, read the way the View menu asks
     * for. Sorted by album a listing is albums rather than tracks, and the
     * menu still has to mean something: covers, a plain list, or one line each.
     */
    function group_block(entries: Map<string, string[]>, open: (name: string) => void) {
        if (layout === 'grid') return group_cards(entries, false, open)

        const art = (tracks: string[]) => tracks.find((track) => cover_of(track)) ?? tracks[0]

        if (layout === 'compact') {
            return (
                <div className='track-rows'>
                    {[...entries].map(([name, tracks], i) => (
                        <div key={name} className='track' onClick={() => open(name)}>
                            <span className='track-index'>{i + 1}</span>
                            <div className='track-meta'>
                                <div className='name ellipsis'>{name}</div>
                                <div className='muted ellipsis'>
                                    {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )
        }

        return (
            <div className='group-list'>
                {[...entries].map(([name, tracks]) => (
                    <div key={name} className='row' onClick={() => open(name)}>
                        {cover(art(tracks), 'row-cover')}

                        <div className='track-meta'>
                            <div className='name ellipsis'>{name}</div>
                            <div className='muted ellipsis'>{artist_of(tracks[0])}</div>
                        </div>

                        <div className='muted row-count'>
                            {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
                        </div>
                        <div className='muted row-length'>
                            {format_span(tracks.reduce((sum, name) => sum + length_of(name), 0))}
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    // one block of the library page: what it is, where the rest of it lives,
    // and ten covers. every block is the same shape, so the page reads as one
    // thing rather than four.
    function shelf(label: string, names: string[], go?: () => void, note?: string) {
        return (
            <section className='block'>
                <div className='shelf-head'>
                    <span className='eyebrow'>{label}</span>
                    {note && <span className='muted'>{note}</span>}
                    {go && (
                        <button className='see-all' onClick={go}>
                            See all
                            <Icon d={ICONS.chevron} size={13} />
                        </button>
                    )}
                </div>

                {track_cards(names)}
            </section>
        )
    }

    function library_page() {
        const on_disk = new Set(songs)
        // a favourite whose file has left the folder cannot be played, so it is
        // not on the shelf either
        const favorite_songs = favorites
            .map((track) => track.file_path)
            .filter((name) => on_disk.has(name))

        const empty = !favorite_songs.length && !liked_songs.length && !has_arrivals

        return (
            <>
                {favorite_songs.length > 0 &&
                    shelf('Favorites', favorite_songs.slice(0, SHELF), () =>
                        set_profile_open(true),
                    )}

                {liked_songs.length > 0 &&
                    shelf('Liked', liked_songs.slice(0, SHELF), () => open_view('liked'))}

                {has_arrivals &&
                    shelf(
                        'New arrivals',
                        arrivals,
                        undefined,
                        `last added ${format_date(added_of(arrivals[0])).toLowerCase()}`,
                    )}

                {empty && (
                    <p className='empty'>
                        Nothing marked yet. Like or favourite a track and it lands here.
                    </p>
                )}
            </>
        )
    }

    // where a suggestion stands: on its way in, already here, or nowhere to be
    // found. the card and the row both read it, and both say the same thing.
    function suggestion_state(track: Suggestion) {
        const busy = getting.includes(track.key)
        const here = library_keys.has(track.key) || fetched.includes(track.key)
        const gone = missing.includes(track.key)

        return {
            busy,
            here,
            gone,
            held: busy || here,
            hint: here
                ? 'Already in your library'
                : busy
                  ? 'Downloading...'
                  : gone
                    ? 'Nothing to download under that name'
                    : 'Download it with the button, right-click for more',
            note: here
                ? 'In your library'
                : busy
                  ? 'Downloading...'
                  : gone
                    ? 'Nothing found'
                    : track.artist || 'Unknown artist',
        }
    }

    // the badge is the button: it fetches straight away. the question is still
    // there, one right-click away on the card.
    function suggestion_badge(track: Suggestion, state: ReturnType<typeof suggestion_state>) {
        return (
            <button
                type='button'
                className={`badge${state.held ? ' on' : ''}`}
                disabled={state.held}
                aria-label={state.here ? 'Already in your library' : 'Download'}
                onClick={(e) => {
                    e.stopPropagation()
                    if (!state.held) void download_suggestion(track)
                }}
            >
                {state.here ? (
                    <Icon d={ICONS.check} size={14} />
                ) : state.busy ? (
                    <span className='spinner' />
                ) : (
                    <Icon d={ICONS.download} size={14} />
                )}
            </button>
        )
    }

    // one suggestion, built like every other card on the page: a cover, a
    // title, an artist. what makes it different is that it is not here yet, so
    // the badge fetches it and a right-click asks first.
    function suggestion_card(track: Suggestion) {
        const state = suggestion_state(track)

        return (
            <div
                key={track.key}
                className={`album suggestion${state.here ? ' owned' : ''}${
                    state.busy ? ' busy' : ''
                }`}
                {...tip(state.hint)}
                onContextMenu={(e) => !state.held && context({ kind: 'suggestion', track })(e)}
            >
                <img
                    className='album-cover'
                    src={track.image}
                    alt=''
                    loading='lazy'
                    // the url came from last.fm and the picture is fetched from
                    // whatever host it names: it can simply not be there
                    onError={(e) => e.currentTarget.classList.add('gone')}
                />

                {suggestion_badge(track, state)}

                <div className='title ellipsis'>{track.title}</div>
                <div className='muted ellipsis'>{state.note}</div>
            </div>
        )
    }

    // the same suggestion laid down instead of stood up: the list view trades
    // the cover for the room to read a long name in
    function suggestion_row(track: Suggestion) {
        const state = suggestion_state(track)

        return (
            <div
                key={track.key}
                className={`sugg-row${state.here ? ' owned' : ''}${state.busy ? ' busy' : ''}`}
                {...tip(state.hint)}
                onContextMenu={(e) => !state.held && context({ kind: 'suggestion', track })(e)}
            >
                <img
                    className='row-cover'
                    src={track.image}
                    alt=''
                    loading='lazy'
                    onError={(e) => e.currentTarget.classList.add('gone')}
                />

                <div className='row-main'>
                    <div className='title ellipsis'>{track.title}</div>
                    <div className='muted ellipsis'>{state.note}</div>
                </div>

                {suggestion_badge(track, state)}
            </div>
        )
    }

    // the last block of the library page: what the shelves above it point at.
    // it is built the same way they are, because it is the same kind of thing -
    // records to look at - and only the click underneath differs.
    function suggestions() {
        const on_screen = similar.slice(0, cards_shown)

        // 'by artist' is the only view that is not a shape: the same cards,
        // gathered under the name they came from, the fullest name first
        const groups = new Map<string, Suggestion[]>()

        if (suggestion_view === 'artist') {
            for (const track of on_screen) {
                const name = track.artist || 'Unknown artist'
                const held = groups.get(name)

                if (held) held.push(track)
                else groups.set(name, [track])
            }
        }

        const shelf_body =
            suggestion_view === 'list' ? (
                <section className='suggestion-list'>{on_screen.map(suggestion_row)}</section>
            ) : suggestion_view === 'artist' ? (
                <div className='by-artist'>
                    {[...groups.entries()]
                        .sort((a, b) => b[1].length - a[1].length)
                        .map(([name, tracks]) => (
                            <section key={name} className='artist-group'>
                                <div className='group-head'>
                                    <span className='ellipsis'>{name}</span>
                                    <span className='muted'>{tracks.length}</span>
                                </div>

                                <section className='card-row compact'>
                                    {tracks.map(suggestion_card)}
                                </section>
                            </section>
                        ))}
                </div>
            ) : (
                <section className={`card-row${suggestion_view === 'compact' ? ' compact' : ''}`}>
                    {on_screen.map(suggestion_card)}
                </section>
            )

        return (
            <section className='block discover'>
                <div className='shelf-head'>
                    <span className='eyebrow'>Suggested for you</span>
                    <span className='muted'>
                        {similar_busy && !similar.length
                            ? 'asking around...'
                            : `${similar.length} tracks`}
                    </span>

                    <div className='shelf-tools'>
                        {/* a whole new pass rather than more of this one: new
                            seeds, and nothing it has already offered */}
                        <button
                            type='button'
                            className='pill-btn pass'
                            disabled={similar_busy}
                            {...tip('Ask again, for different tracks')}
                            onClick={() => void load_similar('again')}
                        >
                            <Icon d={ICONS.refresh} size={13} />
                            Another pass
                        </button>

                        <div className='filter-wrap'>
                            <button
                                type='button'
                                className={`icon-btn filter${suggestion_menu ? ' on' : ''}`}
                                {...tip('View as')}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    set_suggestion_menu(!suggestion_menu)
                                }}
                            >
                                <Icon d={ICONS.filter} size={16} />
                            </button>

                            {suggestion_menu && (
                                <div
                                    className='filter-menu'
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className='filter-label'>View as</div>
                                    {SUGGESTION_VIEWS.map((option) => (
                                        <button
                                            key={option.id}
                                            onClick={() => {
                                                set_suggestion_view(option.id)
                                                save_pref('suggestion_view', option.id)
                                                set_suggestion_menu(false)
                                            }}
                                        >
                                            <span className='ellipsis'>{option.label}</span>
                                            {suggestion_view === option.id && (
                                                <Icon d={ICONS.check} size={14} />
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {similar.length ? (
                    <>
                        {shelf_body}

                        {/* there is always more to dig for, so the button is
                            always there: it uncovers what the pass already
                            found first, and goes back out once that runs out */}
                        <button
                            className='pill-btn more-seeds'
                            disabled={similar_busy}
                            onClick={load_more}
                        >
                            {similar_busy && cards_shown >= similar.length
                                ? 'Looking...'
                                : 'Load more'}
                        </button>
                    </>
                ) : similar_busy ? (
                    // the shape of the shelf, so the page does not jump when it lands
                    <section className='card-row'>
                        {Array.from({ length: 6 }, (_, i) => (
                            <div key={i} className='album skeleton'>
                                <div className='album-cover placeholder' />
                                <div className='bar' />
                                <div className='bar short' />
                            </div>
                        ))}
                    </section>
                ) : (
                    <p className='empty'>
                        Nothing came back this time. Like or favourite a few more tracks,
                        or try another pass.
                    </p>
                )}
            </section>
        )
    }

    /*
     * The shelf at the foot of a listing. It is the library's shelf stripped to
     * what a listing needs: no view menu, because a list is the only way a
     * short shelf under a list of tracks reads, and no page of covers to page
     * through - just rows, and the button that asks for more.
     */
    function nearby_shelf() {
        const on_screen = nearby.slice(0, nearby_shown)
        const named = nearby_key.startsWith('playlist:')
            ? nearby_key.slice('playlist:'.length)
            : 'your liked songs'

        return (
            <section className='block discover'>
                <div className='shelf-head'>
                    <span className='eyebrow'>More like this</span>
                    <span className='muted'>
                        {nearby_busy && !nearby.length
                            ? 'asking around...'
                            : `based on ${named}`}
                    </span>

                    <div className='shelf-tools'>
                        <button
                            type='button'
                            className='pill-btn pass'
                            disabled={nearby_busy}
                            {...tip('Ask again, for different tracks')}
                            onClick={() => void load_nearby('again')}
                        >
                            <Icon d={ICONS.refresh} size={13} />
                            Another pass
                        </button>
                    </div>
                </div>

                {nearby.length ? (
                    <>
                        <section className='suggestion-list'>
                            {on_screen.map((track) => suggestion_row(track))}
                        </section>

                        <button
                            className='pill-btn more-seeds'
                            disabled={nearby_busy}
                            onClick={load_more_nearby}
                        >
                            {nearby_busy && nearby_shown >= nearby.length
                                ? 'Looking...'
                                : 'Load more'}
                        </button>
                    </>
                ) : nearby_busy ? (
                    <section className='suggestion-list'>
                        {Array.from({ length: 4 }, (_, i) => (
                            <div key={i} className='sugg-row skeleton'>
                                <div className='row-cover placeholder' />
                                <div className='row-main'>
                                    <div className='bar' />
                                    <div className='bar short' />
                                </div>
                            </div>
                        ))}
                    </section>
                ) : (
                    <p className='empty'>
                        Nothing came back this time. Try another pass.
                    </p>
                )}
            </section>
        )
    }

    // pinned first in the order they were pinned, the rest alphabetical
    const playlist_names = Object.keys(playlists).sort((a, b) => {
        const rank = (name: string) => (pins.includes(name) ? pins.indexOf(name) : pins.length)

        return rank(a) !== rank(b) ? rank(a) - rank(b) : a.localeCompare(b)
    })

    // everywhere a track can be put. the right-click submenu opens it and so
    // does the button on the card, and neither of them wants a list of its own.
    const playlist_targets = (song: string) => (
        <>
            <button onClick={() => toggle_like(song)}>
                <Icon d={ICONS.heart} size={15} fill={liked.has(song)} />
                <span className='ellipsis'>Liked Songs</span>
                {liked.has(song) && <Icon d={ICONS.check} size={14} />}
            </button>

            {playlist_names.length > 0 && <div className='context-sep' />}

            {playlist_names.map((name) => {
                const inside = playlists[name].includes(song)

                return (
                    <button
                        key={name}
                        onClick={() =>
                            inside ? remove_from_playlist(name, song) : add_to_playlist(name, song)
                        }
                    >
                        <Icon d={ICONS.playlist} size={15} />
                        <span className='ellipsis'>{name}</span>
                        {inside && <Icon d={ICONS.check} size={14} />}
                    </button>
                )
            })}

            <div className='context-sep' />
            <button onClick={() => new_playlist(song)}>
                <Icon d={ICONS.plus} size={15} />
                <span className='ellipsis'>New playlist</span>
            </button>
        </>
    )

    // a playlist shows the sleeve it was given. one that has never been given
    // one still borrows the cover of the first track inside it that has one, so
    // the sidebar reads the same as it always did until somebody picks a photo.
    const playlist_cover = (name: string) =>
        playlist_covers[name] ||
        cover_of((playlists[name] ?? []).find((track) => cover_of(track)) ?? '') ||
        ''

    // nothing ticked is the list this section has always been: playlists alone
    const shelved = shelves.length ? shelves : (['playlists'] as Shelf[])

    // a chip stands for itself: picking albums shows the albums, and letting the
    // last one go falls back to the plain list of playlists
    function toggle_shelf(id: Shelf) {
        const next = shelves.includes(id)
            ? shelves.filter((shelf) => shelf !== id)
            : [...shelves, id]

        set_shelves(next)
        save_pref('shelves', next)
    }

    // an album and a playlist can share a name, so a row is only itself with its
    // kind alongside - which is also what the click and the highlight go by.
    // 'art' is the picture itself rather than the track it came off: a playlist
    // may have one of its own, which belongs to no track at all.
    type Row = { kind: Shelf; name: string; count: number; art: string; pinned: boolean }

    const grouped_rows = (kind: Shelf, groups: Map<string, string[]>): Row[] =>
        [...groups]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, tracks]) => ({
                kind,
                name,
                count: tracks.length,
                art: cover_of(tracks.find((track) => cover_of(track)) ?? '') ?? '',
                pinned: false,
            }))

    const rows: Row[] = [
        ...(shelved.includes('playlists')
            ? playlist_names.map((name) => ({
                  kind: 'playlists' as const,
                  name,
                  count: playlists[name].length,
                  art: playlist_cover(name),
                  pinned: pins.includes(name),
              }))
            : []),
        ...(shelved.includes('albums') ? grouped_rows('albums', albums) : []),
        ...(shelved.includes('artists') ? grouped_rows('artists', artists) : []),
    ]

    function open_row(row: Row) {
        if (row.kind === 'playlists') return open_playlist(row.name)

        // albums and artists are grouped views with one group picked out
        set_profile_open(false)
        set_view(row.kind)
        set_selection(row.name)
    }

    const row_active = (row: Row) =>
        selection === row.name && view === (row.kind === 'playlists' ? 'playlist' : row.kind)

    // the rows stand in for themselves: what the pill has to re-measure against is
    // which of them are on the list, and in what order
    const rows_key = rows.map((row) => `${row.kind}:${row.name}`).join('\u0000')

    // a pill travels between the rows of its own region, so the selection reads as a
    // single object moving rather than two highlights blinking
    useLayoutEffect(() => {
        const host = sidebar_ref.current
        if (!host) return

        const regions = [
            // the library rows sit above the chips and never scroll
            {
                pill: nav_pill.current,
                active: host.querySelector<HTMLElement>('.nav-item.active:not(.playlist-item)'),
            },
            {
                pill: shelf_pill.current,
                active: shelf_ref.current?.querySelector<HTMLElement>('.nav-item.active'),
            },
        ]

        const observers: ResizeObserver[] = []

        for (const { pill, active } of regions) {
            if (!pill) continue

            if (!active) {
                pill.style.opacity = '0'
                continue
            }

            const place = () => {
                // both are measured against the same origin, so the difference cancels
                // out whatever the border contributes to offsetTop
                pill.style.transform = `translateY(${active.offsetTop - pill.offsetTop}px)`
                pill.style.height = `${active.offsetHeight}px`
                pill.style.opacity = '1'
            }

            // nothing to travel from on the first paint, so that one lands without the slide
            if (pill.style.opacity !== '1') {
                pill.style.transition = 'none'
                place()
                void pill.offsetHeight
                pill.style.transition = ''
            } else {
                place()
            }

            const observer = new ResizeObserver(place)

            observer.observe(host)
            observer.observe(active)
            observers.push(observer)
        }

        return () => observers.forEach((observer) => observer.disconnect())
    }, [view, selection, library_view, sidebar_open, rows_key])

    // no room on the right half of the window, so the submenu opens leftwards there
    const flip = !!menu && menu.x > window.innerWidth / 2
    const next_theme: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

    // a sheet is only this track's while it names this track: anything else is
    // the last one, still on screen because the answer for this one is not in yet
    const sheet = sheet_for?.song === current ? sheet_for.text : undefined
    const awaiting_lyrics = !!current && sheet === undefined
    const timed = useMemo(() => (sheet ? parse_lyrics(sheet) : null), [sheet])

    // and the same reading for the card: an answer is this track's while it names
    // this track, and undefined until one has arrived at all
    const info = info_for?.song === current ? info_for.info : undefined
    const awaiting_info = info === undefined

    // the bar and the clock are written straight into these two nodes every frame.
    // the lyric line is the only thing the count moves that needs a render, and it
    // turns over a few times a minute rather than a few times a second.
    const progress_fill = useRef<HTMLSpanElement>(null)
    const elapsed = useRef<HTMLSpanElement>(null)

    const [line_now, set_line_now] = useState(-1)

    useFineClock(position, !!current && !paused, (seconds) => {
        // a drag is showing where the pointer is, not where the track is, and the
        // count can run a little past the end before the poll that stops it lands
        const at = Math.min(seeking ?? seconds, length || Infinity)

        const bar = progress_fill.current
        if (bar) bar.style.width = `${length ? (at / length) * 100 : 0}%`

        const clock = elapsed.current
        const shown = format_time(at)
        if (clock && clock.textContent !== shown) clock.textContent = shown

        // the line in force is the last one whose stamp has passed
        let index = -1
        if (timed) while (index + 1 < timed.length && timed[index + 1].at <= at + 0.15) index++

        if (index !== line_now) set_line_now(index)
    })

    // the sheet is shown in two places and only ever one of them at a time: the
    // rail down the side, and the card turned to its second face
    const lyric_box = useRef<HTMLDivElement>(null)
    const card_box = useRef<HTMLDivElement>(null)

    useLineFollow(lyric_box, line_now, rail_open)
    useLineFollow(card_box, line_now, info_open && info_face === 'lyrics')

    async function seek_to(seconds: number) {
        await bridge().seek(seconds)
        set_position(seconds)

        mpris(() => bridge().mpris_seeked(seconds))
    }

    // the sheet reads three ways and is shown in two places, so the three are
    // written once and handed whichever box is going to do the scrolling
    const sheet_body = (box: React.RefObject<HTMLDivElement | null>) =>
        timed ? (
            <div className='lyric-lines' ref={box}>
                {timed.map((line, i) => (
                    <button
                        key={`${line.at}-${i}`}
                        className={`lyric${
                            i === line_now
                                ? ' now'
                                : Math.abs(i - line_now) === 1
                                  ? ' near'
                                  : ''
                        }${line.text ? '' : ' rest'}`}
                        {...tip('Jump to this line')}
                        onClick={() => seek_to(line.at)}
                    >
                        {line.text || '\u266a'}
                    </button>
                ))}
            </div>
        ) : sheet ? (
            // plain lyrics carry no timing, so there is nothing to follow along
            // with and nothing to click
            <p className='lyric-plain'>{sheet}</p>
        ) : (
            <p className='muted lyric-empty'>
                {awaiting_lyrics ? 'Looking for lyrics...' : 'No lyrics for this track.'}
            </p>
        )

    /*
     * The card the player bar opens into: the record on the left, everything
     * known about what is on it on the right.
     *
     * Only what is actually known goes on it. The file's own tags are the part
     * that is always there, last.fm fills in the rest when it has an entry for
     * the track, and a row it cannot answer for is left off the card rather than
     * printed as a blank - which is why the stats are written out one at a time
     * instead of walked over as a list.
     */
    function track_card(song: string) {
        const is_liked = liked.has(song)
        const starred = is_favorite(song)
        // the tag off the file wins: it is what the library is sorted by, and
        // last.fm's title for the release is only worth borrowing in its absence
        const album = album_of(song)
        const on_sleeve = album === 'Unknown album' && info?.album ? info.album : album

        return (
            <div className='overlay' onClick={close_info}>
                <div className='dialog info-card' onClick={(e) => e.stopPropagation()}>
                    <button
                        className='icon-btn tiny info-close'
                        {...tip('Close')}
                        onClick={close_info}
                    >
                        <Icon d={ICONS.close} size={15} />
                    </button>

                    {/* the record and everything done to it, down one side: the
                        sleeve at the top and the buttons under it, which is the
                        order they are reached in */}
                    <div className='info-side'>
                        <div className='info-art'>
                            {cover(song, 'info-cover')}
                            {/* the whole sleeve is the button: a heart tucked
                                into the corner of a picture this size is a
                                target nobody aims at, and the picture is what
                                is being liked */}
                            <button
                                className={`art-like${is_liked ? ' liked' : ''}`}
                                {...tip(
                                    is_liked ? 'Remove from liked songs' : 'Add to liked songs',
                                )}
                                onClick={() => toggle_like(song)}
                            >
                                <Icon d={ICONS.heart} size={64} fill={is_liked} />
                            </button>
                        </div>

                        <div className='info-actions'>
                            <button className='pill-btn primary' onClick={toggle_pause}>
                                <Icon
                                    d={paused ? ICONS.play : ICONS.pause}
                                    size={15}
                                    fill={paused}
                                />
                                {paused ? 'Play' : 'Pause'}
                            </button>
                            <button
                                className={`pill-btn${info_face === 'lyrics' ? ' on' : ''}`}
                                onClick={() =>
                                    set_info_face(info_face === 'lyrics' ? 'about' : 'lyrics')
                                }
                            >
                                <Icon d={ICONS.playlist} size={15} />
                                {info_face === 'lyrics' ? 'About' : 'Lyrics'}
                            </button>
                            <button
                                className={`pill-btn${starred ? ' on' : ''}`}
                                onClick={() => toggle_favorite(song)}
                            >
                                <Icon d={ICONS.star} size={15} fill={starred} />
                                {starred ? 'Favorited' : 'Favorite'}
                            </button>
                            {/* the list of playlists is the one the right-click
                                menu offers, hung under the button instead of at
                                a cursor. the click must not reach the window, or
                                the listener that dismisses it fires on the way. */}
                            <button
                                className={`pill-btn${info_menu ? ' on' : ''}`}
                                {...tip('Add to a playlist')}
                                onClick={(e) => {
                                    e.stopPropagation()

                                    if (info_menu) return set_info_menu(null)

                                    const rect = e.currentTarget.getBoundingClientRect()

                                    // measured off the top of the button and
                                    // grown upwards: the card's last button has
                                    // no room under it, and a list that covers
                                    // the thing that opened it reads as a slip
                                    set_info_menu({
                                        x: Math.min(rect.left, window.innerWidth - 220),
                                        bottom: Math.max(window.innerHeight - rect.top + 6, 8),
                                    })
                                }}
                            >
                                <Icon d={ICONS.plus} size={15} />
                                Add to
                            </button>
                        </div>
                    </div>

                    <div className='info-body'>
                        <div className='info-head'>
                            <h3 className='info-title'>{title_of(song)}</h3>
                            <div className='info-artist ellipsis'>{artist_of(song)}</div>

                            {!!info?.tags.length && (
                                <div className='info-tags'>
                                    {info.tags.map((tag) => (
                                        <span key={tag} className='info-tag'>
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            )}

                            <div className='info-line'>
                                {[
                                    length_of(song) ? format_time(length_of(song)) : '',
                                    info?.year,
                                    song === current && !paused ? 'Playing' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' \u00b7 ')}
                            </div>
                        </div>

                        <div className='info-face'>
                            {info_face === 'lyrics' ? (
                                sheet_body(card_box)
                            ) : (
                                <>
                                    <dl className='info-stats'>
                                        <dt>Album</dt>
                                        <dd className='ellipsis'>{on_sleeve}</dd>

                                        {!!info?.listeners && (
                                            <>
                                                <dt>Listeners</dt>
                                                <dd>{counted.format(info.listeners)}</dd>
                                            </>
                                        )}

                                        {!!info?.playcount && (
                                            <>
                                                <dt>Scrobbles</dt>
                                                <dd>{counted.format(info.playcount)}</dd>
                                            </>
                                        )}

                                        <dt>Added</dt>
                                        <dd>{format_date(added_of(song))}</dd>
                                    </dl>

                                    {/* whatever is written about the track,
                                        given the whole of what is left under
                                        the rule and set in the middle of it -
                                        three lines pinned to the top of a space
                                        this tall read as something that failed
                                        to finish loading */}
                                    <div className='info-prose'>
                                        {awaiting_info ? (
                                            // three lines of nothing while the
                                            // answer is out: the space has to
                                            // hold something, and it is a
                                            // paragraph that is coming
                                            <div className='info-lines' aria-hidden>
                                                <span />
                                                <span />
                                                <span />
                                            </div>
                                        ) : info?.summary ? (
                                            <p className='info-summary'>{info.summary}</p>
                                        ) : (
                                            <p className='muted info-empty'>
                                                Nothing to show for this one
                                                <span aria-hidden>
                                                    {'(\u00b4\uff65_\uff65`)'}
                                                </span>
                                            </p>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    const view_title = selection ?? NAV.find((item) => item.id === view)?.label ?? 'Playlists'

    return (
        <div className='shell' onContextMenu={(e) => e.preventDefault()}>
            <div className='ambient' aria-hidden>
                {ambient.map((layer, i) =>
                    layer.src ? (
                        <div
                            key={layer.id}
                            // the last one is arriving, anything before it is on its way out
                            className={`ambient-art${i === ambient.length - 1 ? '' : ' out'}`}
                            style={{ backgroundImage: `url(data:image/jpeg;base64,${layer.src})` }}
                        />
                    ) : null,
                )}
            </div>

            <div
                className='frame'
                ref={frame}
                style={{
                    gridTemplateColumns: [
                        sidebar_open ? column(SIDEBAR_BOUNDS, sidebar_w) : '0rem',
                        '1fr',
                        rail_open ? column(RAIL_BOUNDS, rail_w) : '0rem',
                    ].join(' '),
                }}
            >
                <aside
                    className={`sidebar${sidebar_open ? '' : ' collapsed'}`}
                    ref={sidebar_ref}
                    inert={!sidebar_open}
                    onContextMenu={context({ kind: 'sidebar' })}
                >
                    <div className='nav-pill' ref={nav_pill} aria-hidden />

                    <div className='brand'>
                        <span className='brand-mark'>
                            <i />
                            <i />
                            <i />
                        </span>
                        yugen
                        <button
                            className='icon-btn tiny collapse'
                            {...tip('Hide sidebar')}
                            onClick={toggle_sidebar}
                        >
                            <Icon d={ICONS.back} size={16} />
                        </button>
                    </div>

                    <div className='nav-label'>Your Library</div>

                    {NAV.map((item) => (
                        <button
                            key={item.id}
                            className={`nav-item${
                                view === item.id &&
                                !(selection && shelved.includes(item.id as Shelf))
                                    ? ' active'
                                    : ''
                            }`}
                            onClick={() => open_view(item.id)}
                        >
                            <Icon d={item.icon} />
                            {item.label}
                            <span className='nav-count'>{item.count}</span>
                        </button>
                    ))}

                    <div className='nav-label library-label playlists-label'>
                        Playlists
                        <button
                            className={`icon-btn tiny${library_menu ? ' on' : ''}`}
                            {...tip('View as')}
                            onClick={(e) => {
                                e.stopPropagation()

                                // the sidebar clips its overflow, so this one floats free
                                const rect = e.currentTarget.getBoundingClientRect()

                                set_library_menu(
                                    library_menu
                                        ? null
                                        : {
                                              x: Math.min(rect.left, window.innerWidth - 200),
                                              y: rect.bottom + 6,
                                          },
                                )
                            }}
                        >
                            <Icon d={ICONS.filter} size={14} />
                        </button>
                    </div>

                    <div className='shelf-chips' ref={sideways}>
                        {SHELVES.map((option) => (
                            <button
                                key={option.id}
                                className={`chip${shelves.includes(option.id) ? ' on' : ''}`}
                                onClick={() => toggle_shelf(option.id)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>

                    {/* only this scrolls: the brand, the library rows and the chips
                        stay put however long the list gets */}
                    <div className='shelf' ref={shelf_ref}>
                        <div className='nav-pill' ref={shelf_pill} aria-hidden />

                        {rows.length ? (
                            library_view === 'compact-grid' || library_view === 'grid' ? (
                                <div className={`playlist-grid ${library_view}`}>
                                    {rows.map((row) => (
                                        <button
                                            key={`${row.kind}:${row.name}`}
                                            className={`tile${row_active(row) ? ' active' : ''}`}
                                            {...tip(row.name)}
                                            onClick={() => open_row(row)}
                                            onContextMenu={
                                                row.kind === 'playlists'
                                                    ? context({ kind: 'playlist', playlist: row.name })
                                                    : undefined
                                            }
                                        >
                                            {row_cover(row, 'tile-cover', 13)}
                                            <div className='tile-name ellipsis'>
                                                {row.pinned && (
                                                    <span className='pinned' {...tip('Pinned')}>
                                                        <Icon d={ICONS.pin} size={12} fill />
                                                    </span>
                                                )}
                                                {row.name}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                rows.map((row) => (
                                    <button
                                        key={`${row.kind}:${row.name}`}
                                        className={`nav-item playlist-item ${library_view}${
                                            row_active(row) ? ' active' : ''
                                        }`}
                                        onClick={() => open_row(row)}
                                        onContextMenu={
                                            row.kind === 'playlists'
                                                ? context({ kind: 'playlist', playlist: row.name })
                                                : undefined
                                        }
                                    >
                                        {/* a pin used to stand in place of the
                                            picture, so pinning a playlist hid
                                            the cover it was given. it rides
                                            after the name instead. */}
                                        {library_view === 'list' ? (
                                            row_cover(row, 'playlist-cover', 9)
                                        ) : (
                                            // compact carries no covers, so the glyph is the
                                            // only thing saying which kind a row is
                                            <span className='kind-ico'>
                                                <Icon
                                                    d={
                                                        row.kind === 'albums'
                                                            ? ICONS.album
                                                            : row.kind === 'artists'
                                                              ? ICONS.artist
                                                              : ICONS.playlist
                                                    }
                                                    size={15}
                                                />
                                            </span>
                                        )}
                                        <span className='ellipsis'>{row.name}</span>
                                        {row.pinned && (
                                            <span className='pinned' {...tip('Pinned')}>
                                                <Icon d={ICONS.pin} size={13} fill />
                                            </span>
                                        )}
                                        <span className='nav-count'>{row.count}</span>
                                    </button>
                                ))
                            )
                        ) : (
                            <p className='nav-hint'>
                                {shelves.length && !shelves.includes('playlists')
                                    ? 'Nothing to show here yet.'
                                    : 'Right-click here to add one.'}
                            </p>
                        )}
                    </div>

                    <div className='sidebar-foot'>
                        <button className='pill-btn' onClick={fetch_songs} disabled={loading}>
                            <Icon d={ICONS.refresh} size={15} />
                            {loading ? 'Scanning...' : 'Refresh library'}
                        </button>
                    </div>
                </aside>

                <main className='main'>
                    {/* one row across the top of every page, the profile
                        included: the way home, then the way to find something */}
                    <div className='topbar'>
                        <button
                            className='topbar-btn'
                            {...tip('Library')}
                            onClick={() => open_view('library')}
                        >
                            <Icon d={ICONS.home} size={19} />
                        </button>

                        <div className='search-slot'>
                            <label
                                className={`search${search_open ? ' open' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    set_search_open(true)
                                }}
                            >
                                <div className='search-row'>
                                    {searching ? (
                                        <span className='spinner' />
                                    ) : (
                                        <Icon d={ICONS.search} size={15} />
                                    )}
                                    <input
                                        placeholder='Search a song ♪(´▽｀)'
                                        value={query}
                                        onChange={(e) => set_query(e.currentTarget.value)}
                                        onFocus={() => set_search_open(true)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') search()
                                            if (e.key === 'Escape') set_search_open(false)
                                        }}
                                    />
                                    {query && (
                                        <button
                                            className='clear'
                                            {...tip('Clear')}
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                set_query('')
                                                set_results([])
                                                set_shown(PAGE)
                                            }}
                                        >
                                            <Icon d={ICONS.close} size={13} />
                                        </button>
                                    )}
                                </div>

                                {search_open && (
                                    <div className='search-drop'>
                                        <div className='source-tabs'>
                                            {SOURCES.map((option) => (
                                                <button
                                                    key={option.id}
                                                    className={source === option.id ? 'active' : ''}
                                                    onClick={() => switch_source(option.id)}
                                                >
                                                    {option.label}
                                                </button>
                                            ))}
                                        </div>

                                        <div className='search-body'>
                                            {searching &&
                                                Array.from({ length: 5 }, (_, i) => (
                                                    <div key={i} className='result skeleton'>
                                                        <div className='placeholder' />
                                                        <div className='result-meta'>
                                                            <div className='bar' />
                                                            <div className='bar short' />
                                                        </div>
                                                    </div>
                                                ))}

                                            {!searching && !results.length && (
                                                <p className='muted empty-row'>
                                                    {query.trim()
                                                        ? 'Nothing found. Press enter to search again.'
                                                        : 'Type something and press enter.'}
                                                </p>
                                            )}

                                            {!searching &&
                                                results.slice(0, shown).map(search_row)}

                                            {!searching && results.length > shown && (
                                                <button
                                                    className='load-more'
                                                    onClick={() =>
                                                        set_shown((count) => count + PAGE)
                                                    }
                                                >
                                                    Load more
                                                    <span className='muted'>
                                                        {results.length - shown} left
                                                    </span>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </label>
                        </div>

                        {/* it stands down on the profile page: you are already there */}
                        {!profile_open && (
                            <button
                                className='profile-avatar-btn'
                                {...tip(username ? `Hello, ${username}` : 'Profile')}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    set_profile_open(true)
                                }}
                            >
                                <Avatar data={profile_pic} size='sm' alt={username || 'Profile'} />
                            </button>
                        )}
                    </div>

                    {profile_open ? (
                        <>
                        <div className='view-head'>
                            <button
                                className='icon-btn back'
                                {...tip('Back')}
                                onClick={() => set_profile_open(false)}
                            >
                                <Icon d={ICONS.back} size={17} />
                            </button>
                            <h2 className='section-title'>Profile</h2>
                            <button className='pill-btn edit-profile' onClick={open_profile_edit}>
                                <Icon d={ICONS.rename} size={15} />
                                Edit profile
                            </button>
                        </div>

                        <section className='now-section profile-hero'>
                            {/* the picture carries both jobs on hover: the whole
                                profile through the dialog, or just a new photo
                                straight from the picker */}
                            <div className='avatar-edit'>
                                <Avatar
                                    data={profile_pic}
                                    size='lg'
                                    alt={username || 'Profile'}
                                />
                                <div className='avatar-actions'>
                                    <button
                                        className='avatar-action'
                                        onClick={open_profile_edit}
                                    >
                                        <Icon d={ICONS.rename} size={14} />
                                        Edit profile
                                    </button>

                                    <span className='avatar-action'>
                                        {crop_busy ? (
                                            <span className='spinner' />
                                        ) : (
                                            <Icon d={ICONS.upload} size={14} />
                                        )}
                                        Change photo
                                        {/* the picker has to be the element the
                                            click lands on, so it lies over its own
                                            button rather than the whole circle */}
                                        <input
                                            className='avatar-upload-input pill'
                                            type='file'
                                            accept='image/png,image/jpeg'
                                            disabled={crop_busy}
                                            aria-label='Change profile picture'
                                            onChange={(e) => pick_image(e, { kind: 'avatar' })}
                                        />
                                    </span>
                                </div>
                            </div>

                            <div className='now-body'>
                                <h1 className='ellipsis'>{username || 'Unnamed'}</h1>
                                <p
                                    className={`sub profile-bio-text${biography ? '' : ' muted'}`}
                                >
                                    {biography || 'No bio yet.'}
                                </p>

                                {/* the three lists this profile actually owns, counted
                                    off the library itself rather than kept anywhere */}
                                <div className='profile-stats'>
                                    <span>
                                        <b>{favorites.length}</b> favorites
                                    </span>
                                    <span>
                                        <b>{liked_songs.length}</b> liked
                                    </span>
                                    <span>
                                        <b>{playlist_names.length}</b> playlists
                                    </span>
                                </div>
                            </div>
                        </section>

                        <div className='main-scroll'>
                            <div className='view-head'>
                                <h2 className='section-title'>Favorite Songs</h2>
                                <span className='muted'>{favorites.length} tracks</span>
                            </div>

                            {favorites.length ? (
                                <div className='card-row'>
                                    {favorites.map((track) => (
                                        <button
                                            key={track.file_path}
                                            className='album'
                                            onClick={() => play_music(track.file_path)}
                                        >
                                            {cover(track.file_path, 'album-cover')}
                                            <div className='title ellipsis'>
                                                {track.title || track.file_path}
                                            </div>
                                            <div className='muted ellipsis'>
                                                {track.artist || 'Unknown artist'}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <p className='empty'>
                                    No favorite songs yet. Right-click a track to add one.
                                </p>
                            )}
                        </div>
                        </>
                    ) : (
                    <>
                    {/* a playlist puts its own cover at the top of the page, and
                        two hero blocks stacked read as a mistake. what is playing
                        is still on the bar below and in the rail beside it. */}
                    {current && !(view === 'playlist' && selection) && (
                        <section className='now-section'>
                            {cover(current, 'hero-cover')}

                            <div className='now-body'>
                                <div className='label'>Now playing</div>
                                <h1 className='ellipsis'>{title_of(current)}</h1>
                                <div className='sub ellipsis'>
                                    {artist_of(current)} — {album_of(current)}
                                </div>

                                {up_next.length > 0 && (
                                    <div className='up-next'>
                                        <div className='head'>Up next</div>
                                        {up_next.map((name) => (
                                            <div
                                                key={name}
                                                className='track'
                                                onClick={() => play_music(name)}
                                                onContextMenu={song_context(name)}
                                            >
                                                <div className='track-meta'>
                                                    <div className='name ellipsis'>
                                                        {title_of(name)}
                                                    </div>
                                                    <div className='muted ellipsis'>
                                                        {artist_of(name)}
                                                    </div>
                                                </div>
                                                {heart(name)}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {/* the search and what is playing hold their place; only the
                        listing below them scrolls */}
                    <div className='main-scroll'>
                        {/* a playlist is the one listing with nothing behind its
                            name - no album to borrow a sleeve from, no artist -
                            so it gets a head of its own: the cover it was given,
                            what it holds, and the two things you do with it */}
                        {view === 'playlist' && selection && (
                            <section className='playlist-hero'>
                                <button
                                    className='hero-art'
                                    {...tip('Change cover')}
                                    onClick={() => open_dialog({ playlist: selection })}
                                >
                                    <Cover
                                        data={playlist_cover(selection)}
                                        alt={selection}
                                        className='hero-art-img'
                                    />
                                    <span className='hero-art-veil'>
                                        <Icon d={ICONS.upload} size={18} />
                                    </span>
                                </button>

                                <div className='hero-body'>
                                    <span className='eyebrow'>Playlist</span>
                                    <h1 className='ellipsis'>{selection}</h1>
                                    <p className='sub muted'>
                                        {listed.length} {listed.length === 1 ? 'track' : 'tracks'}
                                        {listed_span > 0 && ` · ${format_span(listed_span)}`}
                                    </p>

                                    <div className='hero-actions'>
                                        <button
                                            className='pill-btn primary'
                                            disabled={!listed.length}
                                            onClick={() => void play_listing()}
                                        >
                                            <Icon d={ICONS.play} size={15} />
                                            Play
                                        </button>
                                        <button
                                            className='pill-btn'
                                            onClick={() => open_dialog({ playlist: selection })}
                                        >
                                            <Icon d={ICONS.rename} size={15} />
                                            Edit details
                                        </button>
                                    </div>
                                </div>
                            </section>
                        )}

                        <div className='view-head'>
                            {selection && groups && (
                                <button
                                    className='icon-btn back'
                                    {...tip('Back')}
                                    onClick={() => set_selection(null)}
                                >
                                    <Icon d={ICONS.back} size={17} />
                                </button>
                            )}
                            {/* the playlist's own name is up in the head above,
                                so this one says what the rows underneath are */}
                            <h2 className='section-title ellipsis'>
                                {view === 'playlist' && selection ? 'Tracks' : view_title}
                            </h2>
                            <span className='muted'>
                                {groups && !selection
                                    ? `${groups.size} ${view === 'albums' ? 'albums' : 'artists'}`
                                    : `${listed.length} tracks`}
                            </span>

                            {tunable && (
                                <div className='filter-wrap'>
                                    <button
                                        className={`icon-btn filter${filters ? ' on' : ''}`}
                                        {...tip('Sort and view')}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            set_filters(!filters)
                                        }}
                                    >
                                        <Icon d={ICONS.filter} size={16} />
                                    </button>

                                    {filters && (
                                        <div className='filter-menu' onClick={(e) => e.stopPropagation()}>
                                            <div className='filter-label'>Sort by</div>
                                            {SORTS.map((option) => (
                                                <button
                                                    key={option.id}
                                                    onClick={() => {
                                                        set_sort(option.id)
                                                        save_pref('sort', option.id)
                                                    }}
                                                >
                                                    <span className='ellipsis'>{option.label}</span>
                                                    {sort === option.id && <Icon d={ICONS.check} size={14} />}
                                                </button>
                                            ))}

                                            <div className='context-sep' />

                                            <div className='filter-label'>View as</div>
                                            {LAYOUTS.map((option) => (
                                                <button
                                                    key={option.id}
                                                    onClick={() => choose_layout(option.id)}
                                                >
                                                    <span className='ellipsis'>{option.label}</span>
                                                    {layout === option.id && (
                                                        <Icon d={ICONS.check} size={14} />
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* what the collection amounts to, and the three ways
                            into it that are not this page */}
                        {overview && songs.length > 0 && (
                            <div className='facts'>
                                {total_span > 0 && (
                                    <span className='fact-span'>{format_span(total_span)}</span>
                                )}
                                <button className='fact' onClick={() => open_view('albums')}>
                                    <b>{albums.size}</b> albums
                                </button>
                                <button className='fact' onClick={() => open_view('artists')}>
                                    <b>{artists.size}</b> artists
                                </button>
                                <button className='fact' onClick={() => open_view('liked')}>
                                    <b>{liked_songs.length}</b> liked
                                </button>
                            </div>
                        )}

                        {groups && !selection ? (
                            groups.size ? (
                                group_cards(groups, view === 'artists')
                            ) : (
                                <p className='empty'>Nothing to group yet.</p>
                            )
                        ) : listed.length ? (
                            overview ? (
                                library_page()
                            ) : album_runs ? (
                                group_block(album_runs, (name) => {
                                    set_view('albums')
                                    set_selection(name)
                                })
                            ) : layout === 'list' ? (
                                track_list(listed)
                            ) : layout === 'compact' ? (
                                track_rows(listed)
                            ) : (
                                track_cards(listed)
                            )
                        ) : (
                            <p className='empty'>
                                {loading
                                    ? 'Scanning your library...'
                                    : scan_error
                                      ? `Could not read your library: ${scan_error}`
                                      : view === 'liked'
                                      ? 'No liked songs yet.'
                                      : view === 'playlist'
                                        ? 'This playlist is empty. Right-click a track to add it.'
                                        : `No mp3 files found in ${music_folder}`}
                            </p>
                        )}

                        {/* the shelves above are what is already here; this is
                            what they point at. an empty folder is the one case
                            with nothing to ask about, and a shelf that can only
                            be empty is not worth the room. */}
                        {has_more && suggestions()}

                        {/* the same idea one listing down: what else is like
                            what is in this playlist, or in your liked songs */}
                        {!!nearby_key && listed.length > 0 && nearby_shelf()}
                    </div>

                    </>
                    )}
                </main>

                <aside className={`rightbar${rail_open ? '' : ' collapsed'}`} inert={!rail_open}>
                    <div className='rail-head'>
                        <button className='icon-btn tiny' {...tip('Hide panel')} onClick={toggle_rail}>
                            <Icon d={ICONS.chevron} size={16} />
                        </button>
                    </div>

                    {current && (
                        <section className='lyrics'>
                            <div className='lyric-head'>
                                <h2 className='section-title'>Lyrics</h2>
                                {/* without stamps there is no line to follow and
                                    nothing to jump to, which is worth saying */}
                                {sheet && !timed && <span className='muted'>Not synced</span>}
                            </div>

                            {sheet_body(lyric_box)}
                        </section>
                    )}

                    {liked_songs.length > 0 && (
                        <section>
                            <h2 className='section-title'>Liked Songs</h2>
                            {liked_songs.map((name) => (
                                <button
                                    key={name}
                                    className='result'
                                    onClick={() => play_music(name)}
                                    onContextMenu={song_context(name)}
                                >
                                    {cover(name, '')}
                                    <div className='result-meta'>
                                        <div className='name ellipsis'>{title_of(name)}</div>
                                        <div className='muted ellipsis'>{artist_of(name)}</div>
                                    </div>
                                </button>
                            ))}
                        </section>
                    )}
                </aside>

                {sidebar_open && (
                    <div
                        className='resizer'
                        style={{
                            left: `calc(${column(SIDEBAR_BOUNDS, sidebar_w)} + var(--gutter) / 2)`,
                        }}
                        onPointerDown={start_resize('sidebar')}
                        onPointerMove={move_resize}
                        onPointerUp={end_resize}
                        onPointerCancel={end_resize}
                    />
                )}
                {rail_open && (
                    <div
                        className='resizer'
                        style={{
                            left: `calc(100% - ${column(RAIL_BOUNDS, rail_w)} - var(--gutter) / 2)`,
                        }}
                        onPointerDown={start_resize('rail')}
                        onPointerMove={move_resize}
                        onPointerUp={end_resize}
                        onPointerCancel={end_resize}
                    />
                )}

                {!sidebar_open && (
                    <button className='edge-toggle left' {...tip('Show sidebar')} onClick={toggle_sidebar}>
                        <Icon d={ICONS.chevron} size={18} />
                    </button>
                )}

                {/* while cramped the rail has nowhere to go, but a handle that
                    vanishes mid-drag reads as a bug: it stays put and says why */}
                {rail_hidden && (
                    <button
                        className={`edge-toggle right${cramped ? ' blocked' : ''}`}
                        {...tip(cramped ? 'No room for the panel' : 'Show panel')}
                        aria-disabled={cramped}
                        onClick={() => !cramped && toggle_rail()}
                    >
                        <Icon d={ICONS.back} size={18} />
                    </button>
                )}
            </div>

            {info_menu && current && (
                <div
                    className='context-menu info-menu'
                    style={{ left: info_menu.x, bottom: info_menu.bottom }}
                >
                    {playlist_targets(current)}
                </div>
            )}

            {menu && (
                <div className='context-menu' style={{ left: menu.x, top: menu.y }}>
                    {menu.kind === 'song' && (
                        <>
                            <div className='context-head ellipsis'>{title_of(menu.song)}</div>
                            <button onClick={() => play_music(menu.song)}>
                                <Icon d={ICONS.play} size={15} fill />
                                Play
                            </button>
                            <button onClick={() => toggle_like(menu.song)}>
                                <Icon d={ICONS.heart} size={15} fill={liked.has(menu.song)} />
                                {liked.has(menu.song) ? 'Remove from liked' : 'Add to liked'}
                            </button>
                            <button onClick={() => toggle_favorite(menu.song)}>
                                <Icon d={ICONS.star} size={15} fill={is_favorite(menu.song)} />
                                {is_favorite(menu.song) ? 'Remove from favorites' : 'Add to favorites'}
                            </button>

                            {view === 'playlist' &&
                                selection &&
                                playlists[selection]?.includes(menu.song) && (
                                    <button
                                        onClick={() => remove_from_playlist(selection, menu.song)}
                                    >
                                        <Icon d={ICONS.minus} size={15} />
                                        Remove from {selection}
                                    </button>
                                )}

                            <div className='context-sep' />
                            <div
                                className='submenu-wrap'
                                onMouseEnter={() => set_submenu(true)}
                                onMouseLeave={() => set_submenu(false)}
                            >
                                <button
                                    className={`submenu-item${submenu ? ' open' : ''}`}
                                    // the menu closes on any click, so this one has to stay put
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Icon d={ICONS.plus} size={15} />
                                    Add to
                                    <Icon d={ICONS.chevron} size={14} />
                                </button>

                                {submenu && (
                                    <div className={`context-menu submenu${flip ? ' flip' : ''}`}>
                                        {playlist_targets(menu.song)}
                                    </div>
                                )}
                            </div>

                            <div className='context-sep' />
                            <button className='danger' onClick={() => remove_song(menu.song)}>
                                <Icon d={ICONS.trash} size={15} />
                                Delete from disk
                            </button>
                        </>
                    )}

                    {menu.kind === 'suggestion' && (
                        <>
                            <div className='context-head'>
                                <div className='name ellipsis'>{menu.track.title}</div>
                                <div className='ellipsis'>
                                    {menu.track.artist || 'Unknown artist'}
                                </div>
                            </div>
                            <button onClick={() => download_suggestion(menu.track)}>
                                <Icon d={ICONS.download} size={15} />
                                Download
                            </button>
                        </>
                    )}

                    {menu.kind === 'playlist' && (
                        <>
                            <div className='context-head ellipsis'>{menu.playlist}</div>
                            <button onClick={() => toggle_pin(menu.playlist)}>
                                <Icon d={ICONS.pin} size={15} />
                                {pins.includes(menu.playlist) ? 'Unpin playlist' : 'Pin playlist'}
                            </button>
                            <button
                                onClick={() =>
                                    open_dialog({ playlist: menu.playlist })
                                }
                            >
                                <Icon d={ICONS.rename} size={15} />
                                Rename
                            </button>
                            <button
                                className='danger'
                                onClick={() => delete_playlist(menu.playlist)}
                            >
                                <Icon d={ICONS.trash} size={15} />
                                Delete playlist
                            </button>
                        </>
                    )}

                    {menu.kind === 'sidebar' && (
                        <button onClick={() => new_playlist()}>
                            <Icon d={ICONS.plus} size={15} />
                            New playlist
                        </button>
                    )}
                </div>
            )}

            {aura_menu && (
                <div
                    className='aura-menu'
                    style={{ left: aura_menu.x, top: aura_menu.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className='filter-label'>
                        Cover tint
                        <span>{aura}%</span>
                    </div>
                    <input
                        className='slider'
                        type='range'
                        min={AURA_RANGE[0]}
                        max={AURA_RANGE[1]}
                        step={5}
                        value={aura}
                        aria-label='How much of the cover reaches the background'
                        onChange={(e) => set_aura(Number(e.currentTarget.value))}
                        // written once the drag ends rather than on every step
                        onPointerUp={() => save_pref('aura', aura)}
                        onKeyUp={() => save_pref('aura', aura)}
                    />
                    <p className='aura-hint'>How much of the artwork reaches the background.</p>
                </div>
            )}

            {volume_menu && (
                <div
                    className='aura-menu'
                    style={{ left: volume_menu.x, top: volume_menu.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className='filter-label'>
                        Volume
                        <span>{Math.round(volume * 100)}%</span>
                    </div>
                    <input
                        className='slider'
                        type='range'
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        aria-label='Volume'
                        onChange={(e) => {
                            const v = Number(e.currentTarget.value)

                            if (v > 0) set_prev_volume(v)
                            change_volume(v)
                        }}
                    />
                </div>
            )}

            {shuffle_menu && (
                <div
                    className='filter-menu floating shuffle-menu'
                    style={{ left: shuffle_menu.x, bottom: window.innerHeight - shuffle_menu.y }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className='filter-label'>Shuffle</div>
                    {SHUFFLES.map((option) => (
                        <button
                            key={option.id}
                            onClick={() => {
                                set_shuffle_menu(null)
                                void shuffle_into(option.id)
                            }}
                        >
                            <span className='ellipsis'>
                                {option.label}
                                <span className='muted'>{option.hint}</span>
                            </span>
                            {shuffle_mode === option.id && <Icon d={ICONS.check} size={14} />}
                        </button>
                    ))}
                </div>
            )}

            {library_menu && (
                <div
                    className='filter-menu floating'
                    style={{ left: library_menu.x, top: library_menu.y }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className='filter-label'>View as</div>
                    {LIBRARY_VIEWS.map((option) => (
                        <button
                            key={option.id}
                            onClick={() => {
                                set_library_view(option.id)
                                save_pref('library_view', option.id)
                            }}
                        >
                            <span className='ellipsis'>{option.label}</span>
                            {library_view === option.id && <Icon d={ICONS.check} size={14} />}
                        </button>
                    ))}
                </div>
            )}

            {dialog && (
                <div className='overlay' onClick={() => set_dialog(null)}>
                    <div className='dialog' onClick={(e) => e.stopPropagation()}>
                        <h3>Edit details</h3>

                        {/* the sleeve leads, centred, because it is the thing
                            being edited. the way to change it is the picture
                            itself - it comes up under the pointer rather than
                            standing beside it as a second control. */}
                        <div className='cover-pick'>
                            <span className='cover-mark playlist-art-wrap'>
                                <Cover
                                    data={playlist_cover(dialog.playlist)}
                                    alt={dialog.playlist}
                                    className='playlist-art'
                                />
                                <span className='kind-mark' aria-hidden>
                                    <Icon d={ICONS.playlist} size={13} />
                                </span>

                                <span className='cover-veil'>
                                    {crop_busy ? (
                                        <span className='spinner' />
                                    ) : (
                                        <>
                                            <Icon d={ICONS.upload} size={20} />
                                            Change
                                        </>
                                    )}
                                    {/* the picker has to be the element the click
                                        lands on, so it lies over the whole square */}
                                    <input
                                        className='avatar-upload-input'
                                        type='file'
                                        accept='image/png,image/jpeg'
                                        disabled={crop_busy}
                                        aria-label='Change playlist cover'
                                        onChange={(e) =>
                                            pick_image(e, {
                                                kind: 'playlist',
                                                name: dialog.playlist,
                                            })
                                        }
                                    />
                                </span>
                            </span>

                            <p className='cover-pick-hint'>
                                {playlist_covers[dialog.playlist]
                                    ? 'This playlist has a cover of its own.'
                                    : 'Borrowing the cover of the first track in it.'}
                            </p>
                        </div>

                        <label className='field'>
                            Name
                            <input
                                autoFocus
                                placeholder='Playlist name'
                                value={draft}
                                onChange={(e) => set_draft(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commit_dialog()
                                    if (e.key === 'Escape') set_dialog(null)
                                }}
                            />
                        </label>
                        <div className='dialog-actions'>
                            <button className='pill-btn' onClick={() => set_dialog(null)}>
                                Cancel
                            </button>
                            <button
                                className='pill-btn primary'
                                onClick={commit_dialog}
                                disabled={!draft.trim()}
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {crop_src && (
                <CropDialog
                    src={crop_src}
                    busy={crop_busy}
                    shape={crop_for.kind === 'avatar' ? 'round' : 'square'}
                    title={crop_for.kind === 'avatar' ? 'Crop photo' : 'Crop cover'}
                    on_cancel={() => set_crop_src('')}
                    on_done={save_crop}
                />
            )}

            {profile_edit_open && (
                <div className='overlay' onClick={() => set_profile_edit_open(false)}>
                    <div
                        className='dialog profile-dialog'
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className='dialog-head'>
                            <h3>Edit profile</h3>
                            <button
                                className='icon-btn tiny'
                                {...tip('Close')}
                                onClick={() => set_profile_edit_open(false)}
                            >
                                <Icon d={ICONS.close} size={15} />
                            </button>
                        </div>

                        <div className='profile-dialog-body'>
                            <div className='avatar-edit'>
                                <Avatar
                                    data={profile_pic}
                                    size='md'
                                    alt={username || 'Profile'}
                                />
                                {/* it says what it does, so it needs no tooltip -
                                    one over a dialog this small lands on the title */}
                                <div className='avatar-upload' aria-hidden='true'>
                                    {crop_busy ? (
                                        <span className='spinner' />
                                    ) : (
                                        <>
                                            <Icon d={ICONS.upload} size={18} />
                                            Change
                                        </>
                                    )}
                                </div>
                                {/*
                                    the file picker has to be the element the click
                                    actually lands on - some webviews silently refuse to
                                    open the native dialog for a programmatic .click()
                                    proxied through a button, so this sits transparent on
                                    top of the artwork instead
                                */}
                                <input
                                    className='avatar-upload-input'
                                    type='file'
                                    accept='image/png,image/jpeg'
                                    disabled={crop_busy}
                                    aria-label='Change profile picture'
                                    onChange={(e) => pick_image(e, { kind: 'avatar' })}
                                />
                            </div>

                            <div className='profile-dialog-fields'>
                                <label className='field'>
                                    Name
                                    <input
                                        autoFocus
                                        placeholder='Your name'
                                        value={username_draft}
                                        onChange={(e) =>
                                            set_username_draft(e.currentTarget.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') commit_profile_edit()
                                            if (e.key === 'Escape')
                                                set_profile_edit_open(false)
                                        }}
                                    />
                                </label>
                                <label className='field'>
                                    Bio
                                    <textarea
                                        className='bio-input'
                                        placeholder='Add a bio'
                                        value={bio_draft}
                                        onChange={(e) =>
                                            set_bio_draft(e.currentTarget.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === 'Escape')
                                                set_profile_edit_open(false)
                                        }}
                                    />
                                </label>
                            </div>
                        </div>

                        <p className='dialog-hint'>
                            Kept on this device only, next to your library.
                        </p>

                        <div className='dialog-actions'>
                            <button
                                className='pill-btn'
                                onClick={() => set_profile_edit_open(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className='pill-btn primary'
                                onClick={commit_profile_edit}
                                disabled={!username_draft.trim()}
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {info_open && current && track_card(current)}

            <div className='player'>
                <div
                    className={`progress${seeking !== null ? ' dragging' : ''}`}
                    onPointerDown={start_seek}
                    onPointerMove={move_seek}
                    onPointerUp={commit_seek}
                    onPointerCancel={() => set_seeking(null)}
                >
                    <div className='progress-track'>
                        <span ref={progress_fill} />
                    </div>
                </div>

                <div
                    className='playing-info'
                    onContextMenu={current ? song_context(current) : undefined}
                >
                    {current ? (
                        <>
                            {/* the sleeve and the two lines are one target: both
                                of them are the track, and the track is what the
                                card is about. the heart stays outside it, since
                                a like is not a way of asking about anything */}
                            <button
                                className='playing-open'
                                {...tip('Track info')}
                                onClick={open_info}
                            >
                                {cover(current, '')}
                                <div className='track-meta'>
                                    <div className='ellipsis'>{title_of(current)}</div>
                                    <div className='muted ellipsis'>{artist_of(current)}</div>
                                </div>
                            </button>
                            {heart(current, 'static', 18)}
                        </>
                    ) : (
                        <>
                            <div className='placeholder'>♪</div>
                            <div className='track-meta muted'>Nothing playing</div>
                        </>
                    )}
                </div>

                <div className='controls'>
                    {/* one click steps to the next state, a right-click picks
                        one outright - or deals the same one again, which is the
                        only way to re-roll an order without cycling past it */}
                    <button
                        className={`ctrl${shuffle_mode !== 'off' ? ' on' : ''}${
                            shuffle_mode === 'all' ? ' wide' : ''
                        }`}
                        {...tip(
                            `${
                                shuffle_mode === 'off'
                                    ? 'Shuffle off'
                                    : shuffle_mode === 'listing'
                                      ? 'Shuffling this listing'
                                      : 'Shuffling everything'
                            } · right-click to pick`,
                        )}
                        onClick={() => void shuffle_into(next_shuffle())}
                        onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()

                            const rect = e.currentTarget.getBoundingClientRect()
                            set_shuffle_menu(
                                shuffle_menu ? null : { x: rect.left, y: rect.top - 10 },
                            )
                        }}
                        disabled={!listed.length}
                    >
                        <Icon d={ICONS.shuffle} size={17} />
                    </button>
                    <button
                        className='ctrl'
                        {...tip('Previous')}
                        onClick={() => skip(-1)}
                        disabled={!queue.length}
                    >
                        <Icon d={ICONS.prev} size={18} fill />
                    </button>
                    <button
                        className='ctrl play'
                        {...tip(paused ? 'Resume' : 'Pause')}
                        onClick={toggle_pause}
                        disabled={!current}
                    >
                        <Icon d={paused ? ICONS.play : ICONS.pause} size={16} fill={paused} />
                    </button>
                    <button
                        className='ctrl'
                        {...tip('Next')}
                        onClick={() => skip(1)}
                        disabled={!queue.length}
                    >
                        <Icon d={ICONS.next} size={18} fill />
                    </button>
                    <button
                        className={`ctrl${looped ? ' on' : ''}`}
                        {...tip(looped ? 'Stop repeating' : 'Repeat this track')}
                        onClick={toggle_loop}
                    >
                        <Icon d={ICONS.loop} size={17} />
                    </button>
                </div>

                <div className='player-right'>
                    <button
                        className={`icon-btn tiny${volume === 0 ? '' : ' on'}`}
                        {...tip(
                            volume === 0
                                ? 'Volume · right-click to unmute'
                                : 'Volume · right-click to mute',
                        )}
                        onClick={(e) => {
                            // the window listener that dismisses the menu goes up
                            // the moment it opens, so this click must not reach it
                            e.stopPropagation()

                            const rect = e.currentTarget.getBoundingClientRect()

                            set_volume_menu(
                                volume_menu ? null : { x: rect.right, y: rect.top - 10 },
                            )
                        }}
                        onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()

                            if (volume === 0) {
                                change_volume(prev_volume > 0 ? prev_volume : 0.5)
                            } else {
                                set_prev_volume(volume)
                                change_volume(0)
                            }
                        }}
                    >
                        <Icon
                            d={
                                volume === 0
                                    ? ICONS.volume_mute
                                    : volume < 0.5
                                      ? ICONS.volume_low
                                      : ICONS.volume_high
                            }
                            size={15}
                        />
                    </button>
                    <button
                        className={`icon-btn tiny${share_dc ? ' on' : ''}`}
                        {...tip(
                            share_dc
                                ? 'Stop sharing activity on Discord'
                                : 'Share activity on Discord',
                        )}
                        aria-pressed={share_dc}
                        onClick={async () => {
                            // setting it rather than flipping it, so a click that
                            // lands twice cannot leave the two sides disagreeing
                            await bridge().set_activity(!share_dc)

                            set_share_dc(!share_dc)
                            save_pref('share_dc', !share_dc)
                        }}
                    >
                        <Icon d={ICONS.discord} size={15} />
                    </button>
                    
                    <button
                        className={`icon-btn tiny${aura_on ? ' on' : ''}`}
                        {...tip(
                            !aura_on
                                ? 'Turn cover tint on'
                                : current_cover
                                  ? 'Turn cover tint off · right-click to adjust'
                                  : 'Turn cover tint off',
                        )}
                        onClick={() => {
                            set_aura_on(!aura_on)
                            save_pref('aura_on', !aura_on)
                        }}
                        // the strength lives behind a right-click, the same place every
                        // other secondary action in the app lives
                        onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()

                            // nothing to set the strength of while it is off, or while
                            // there is no artwork on screen to tint with
                            if (!aura_on || !current_cover) return

                            const rect = e.currentTarget.getBoundingClientRect()

                            set_aura_menu(
                                aura_menu ? null : { x: rect.right, y: rect.top - 10 },
                            )
                        }}
                    >
                        <Icon d={ICONS.aura} size={15} />
                    </button>
                    <button
                        className='icon-btn tiny'
                        {...tip(`Switch to ${next_theme} theme`)}
                        onClick={() => {
                            set_theme(next_theme)
                            save_pref('theme', next_theme)
                        }}
                    >
                        <Icon
                            d={
                                theme === 'system'
                                    ? ICONS.system
                                    : theme === 'light'
                                      ? ICONS.sun
                                      : ICONS.moon
                            }
                            size={15}
                        />
                    </button>
                    <span ref={elapsed}>0:00</span> / {format_time(length)}
                </div>
            </div>

            {active_tip && (
                <div
                    className={`tip${active_tip.below ? ' below' : ''}`}
                    ref={tip_box}
                    role='tooltip'
                    style={{ left: active_tip.x, top: active_tip.y }}
                >
                    {active_tip.text}
                </div>
            )}
        </div>
    )
}
