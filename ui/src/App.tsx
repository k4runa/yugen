import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const FILE_PATH = '/home/g4lice/Musics/'
const LAYOUT_KEY = 'yugen.layout'

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

function save_pref(key: string, value: string | string[] | boolean) {
    try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...saved, [key]: value }))
    } catch {
        // storage unavailable, the choice just will not stick
    }
}

type Theme = 'system' | 'light' | 'dark'
type View = 'library' | 'liked' | 'albums' | 'artists' | 'playlist'

// right-click targets: a track, a playlist in the sidebar, or the sidebar itself
type MenuTarget =
    { kind: 'song'; song: string } | { kind: 'playlist'; playlist: string } | { kind: 'sidebar' }

type Menu = MenuTarget & { x: number; y: number }

type Dialog = { mode: 'create'; song?: string } | { mode: 'rename'; playlist: string }

type Sort = 'title' | 'added' | 'artist' | 'album'
type Layout = 'list' | 'compact'

const SORTS: { id: Sort; label: string }[] = [
    { id: 'title', label: 'Title' },
    { id: 'added', label: 'Recently added' },
    { id: 'artist', label: 'Artist' },
    { id: 'album', label: 'Album' },
]

const LAYOUTS: { id: Layout; label: string }[] = [
    { id: 'list', label: 'List' },
    { id: 'compact', label: 'Compact' },
]

type LibraryView = 'compact' | 'list' | 'compact-grid' | 'grid'

const LIBRARY_VIEWS: { id: LibraryView; label: string }[] = [
    { id: 'compact', label: 'Compact' },
    { id: 'list', label: 'List' },
    { id: 'compact-grid', label: 'Compact grid' },
    { id: 'grid', label: 'Default grid' },
]

type Source = 'yt' | 'sc'

type SearchResult = {
    title: string
    // a video id on youtube, the track's page url on soundcloud
    ref: string
    thumbnail?: string
}

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

// the functions main.cpp exposes through saucer
type Bridge = {
    fetch_songs(path: string): Promise<string[]>
    get_metadata(path: string): Promise<string[]>
    get_cover(path: string): Promise<string>
    play_music(path: string): Promise<void>
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
    create_playlist(playlist: string): Promise<boolean>
    delete_playlist(playlist: string): Promise<boolean>
    rename_playlist(playlist: string, renamed: string): Promise<boolean>
    add_to_playlist(playlist: string, name: string): Promise<boolean>
    remove_from_playlist(playlist: string, name: string): Promise<boolean>
}

declare global {
    interface Window {
        saucer: { exposed: Bridge }
    }
}

// saucer injects the bridge on the window at runtime
const bridge = () => window.saucer.exposed

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
            title={liked ? 'Remove from liked songs' : 'Add to liked songs'}
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
    library: 'M4 20V9m4 11V4m4 16v-7m4 7V7m4 13v-4',
    heart: 'M19.5 12.6 12 20l-7.5-7.4a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l1 1 1-1a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5',
    album: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
    artist: 'M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0',
    back: 'M15 5l-7 7 7 7',
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
}

export default function App() {
    const [theme, set_theme] = useState<Theme>('system')
    const [view, set_view] = useState<View>('library')
    const [selection, set_selection] = useState<string | null>(null)

    const [songs, set_songs] = useState<string[]>([])
    const [metadata_map, set_metadata_map] = useState<Record<string, string[]>>({})
    const [covers_map, set_covers_map] = useState<Record<string, string>>({})
    const [liked, set_liked] = useState<Set<string>>(new Set())
    const [loading, set_loading] = useState(false)

    const [current, set_current] = useState<string | null>(null)
    const [paused, set_paused] = useState(false)
    const [looped, set_looped] = useState(false)
    const [length, set_length] = useState(0)
    const [position, set_position] = useState(0)
    const [seeking, set_seeking] = useState<number | null>(null)
    const [shuffle_on, set_shuffle_on] = useState(false)
    const [shuffled, set_shuffled] = useState<{
        key: string
        order: string[]
    } | null>(null)

    const [menu, set_menu] = useState<Menu | null>(null)
    const [submenu, set_submenu] = useState(false)
    const [filters, set_filters] = useState(false)

    const [sort, set_sort] = useState<Sort>(() =>
        stored_pref('sort', SORTS.map((s) => s.id), 'title'),
    )
    const [track_layout, set_track_layout] = useState<Layout>(() =>
        stored_pref('track_layout', LAYOUTS.map((l) => l.id), 'list'),
    )
    const [dialog, set_dialog] = useState<Dialog | null>(null)
    const [draft, set_draft] = useState('')

    // name -> its tracks, kept in sync with playlists.json
    const [playlists, set_playlists] = useState<Record<string, string[]>>({})
    const [pins, set_pins] = useState<string[]>(stored_pins)

    const [library_menu, set_library_menu] = useState<{ x: number; y: number } | null>(null)
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

    const [query, set_query] = useState('')
    const [searching, set_searching] = useState(false)
    const [results, set_results] = useState<SearchResult[]>([])
    const [downloading, set_downloading] = useState<string | null>(null)
    const [source, set_source] = useState<Source>('yt')
    const [search_open, set_search_open] = useState(false)


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
        // with no attribute the stylesheet falls back to prefers-color-scheme
        if (theme === 'system') delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = theme
    }, [theme])

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
        fetch_songs()
        sync_liked()
        sync_playlists()
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

    async function fetch_songs() {
        set_loading(true)
        const names: string[] = await bridge().fetch_songs(FILE_PATH)

        const metadata: Record<string, string[]> = {}
        const covers: Record<string, string> = {}

        for (const name of names) {
            metadata[name] = await bridge().get_metadata(FILE_PATH + name)
            covers[name] = await bridge().get_cover(FILE_PATH + name)
        }

        set_songs(names)
        set_metadata_map(metadata)
        set_covers_map(covers)
        set_loading(false)
    }

    // liked_songs.json is the source of truth, so read it back after every write
    async function sync_liked() {
        try {
            set_liked(new Set(await bridge().get_liked_songs()))
        } catch {
            // keep showing whatever we have rather than dropping the list
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

    // playlists.json is small, so the whole thing is pulled in one go
    async function sync_playlists() {
        try {
            const names = await bridge().get_playlists()
            const tracks = await Promise.all(names.map((name) => bridge().get_playlist(name)))

            set_playlists(Object.fromEntries(names.map((name, i) => [name, tracks[i]])))
        } catch {
            // keep the last known list rather than blanking the sidebar
        }
    }

    async function create_playlist(name: string) {
        const trimmed = name.trim()
        if (!trimmed) return

        await bridge().create_playlist(trimmed)
        await sync_playlists()
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
        await bridge().delete_song(FILE_PATH + name)

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
        await bridge().play_music(FILE_PATH + name)
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
    }

    async function nudge(seconds: number) {
        if (!current || !length) return

        const target = Math.min(Math.max(position + seconds, 0), length)

        set_position(target)
        await bridge().seek(target)
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

    async function search(on: Source = source) {
        if (!query.trim()) return

        set_searching(true)
        set_search_open(true)

        // both searches print one flat list, a fixed number of lines per result
        const flat: string[] =
            on === 'yt' ? await bridge().search_yt(query, 10) : await bridge().search_sc(query, 10)

        const { fields, ref } = SHAPE[on]

        set_results(
            Array.from({ length: Math.floor(flat.length / fields) }, (_, i) => ({
                title: flat[i * fields],
                ref: flat[i * fields + 1],
                thumbnail: printed(flat[i * fields + 2]),
            }))
                // a flat search also turns up channels and playlists, which are not tracks
                .filter((result) => ref.test(result.ref)),
        )
        set_searching(false)
    }

    // soundcloud sends an artwork url, youtube's is built from the video id
    const artwork = (result: SearchResult) =>
        source === 'yt' ? `https://img.youtube.com/vi/${result.ref}/mqdefault.jpg` : result.thumbnail

    function switch_source(next: Source) {
        set_source(next)
        set_results([])

        if (query.trim()) search(next)
    }

    async function download(result: SearchResult) {
        set_downloading(result.ref)

        if (source === 'yt') await bridge().download_yt(result.ref, FILE_PATH)
        else await bridge().download_sc(result.ref, FILE_PATH)

        set_downloading(null)
        await fetch_songs()
        await sync_liked()
    }

    function open_playlist(name: string) {
        set_view('playlist')
        set_selection(name)
    }

    function open_view(next: View) {
        set_view(next)
        set_selection(null)
    }

    const title_of = (name: string) => metadata_map[name]?.[0] || name.replace(/\.mp3$/i, '')
    const artist_of = (name: string) => metadata_map[name]?.[1] || 'Unknown artist'
    const album_of = (name: string) => metadata_map[name]?.[2] || 'Unknown album'
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

    // a playlist only lists what is still on disk
    const playlist_songs =
        view === 'playlist' && selection
            ? (playlists[selection] ?? [])
                  .filter((name) => songs.includes(name))
                  .sort((a, b) =>
                      // newest first for dates, alphabetical for the rest
                      sort === 'added'
                          ? added_of(b) - added_of(a)
                          : sort === 'artist'
                            ? artist_of(a).localeCompare(artist_of(b))
                            : sort === 'album'
                              ? album_of(a).localeCompare(album_of(b))
                              : title_of(a).localeCompare(title_of(b)),
                  )
            : []

    // the current queue: what prev/next walks through
    const listed =
        view === 'playlist'
            ? playlist_songs
            : selection
              ? (groups?.get(selection) ?? [])
              : view === 'liked'
                ? liked_songs
                : songs

    // prev/next walk the shuffled order when shuffle is on, otherwise the view order
    const listed_key = listed.join('\u0000')
    const queue = shuffle_on && shuffled?.key === listed_key ? shuffled.order : listed

    // the backend owns the shuffling, so re-ask whenever the toggle or the listing changes
    useEffect(() => {
        if (!shuffle_on) return

        let cancelled = false
        bridge()
            .shuffle(listed)
            .then((order) => !cancelled && set_shuffled({ key: listed_key, order }))

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- listed_key stands in for listed
    }, [shuffle_on, listed_key])

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

    const up_next = current ? queue.slice(queue.indexOf(current) + 1).slice(0, 4) : []

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

    function end_resize(e: React.PointerEvent<HTMLDivElement>) {
        const drag = resizing.current

        e.currentTarget.classList.remove('active')
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

        const height = target.kind === 'song' ? 230 : target.kind === 'playlist' ? 150 : 70

        set_submenu(false)
        set_menu({
            ...target,
            x: Math.min(e.clientX, window.innerWidth - 220),
            y: Math.min(e.clientY, Math.max(window.innerHeight - height, 8)),
        })
    }

    const song_context = (name: string) => context({ kind: 'song', song: name })

    function open_dialog(next: Dialog) {
        set_draft(next.mode === 'rename' ? next.playlist : '')
        set_dialog(next)
    }

    async function commit_dialog() {
        if (!dialog) return

        set_dialog(null)

        if (dialog.mode === 'rename') return rename_playlist(dialog.playlist, draft)

        await create_playlist(draft)

        // opened from a track: the point was to put that track somewhere new
        if (dialog.song) await add_to_playlist(draft.trim(), dialog.song)
    }

    // local wrappers so call sites stay short
    const cover = (name: string, className: string) => (
        <Cover data={cover_of(name)} alt={title_of(name)} className={className} />
    )

    const heart = (name: string, className?: string, size?: number) => (
        <Heart
            liked={liked.has(name)}
            on_toggle={() => toggle_like(name)}
            className={className}
            size={size}
        />
    )

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
                            <span className='eq'>
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
    function group_cards(entries: Map<string, string[]>, round?: boolean) {
        return (
            <section className='card-row'>
                {[...entries].map(([name, tracks]) => (
                    <div key={name} className='album' onClick={() => set_selection(name)}>
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

    // pinned first in the order they were pinned, the rest alphabetical
    const playlist_names = Object.keys(playlists).sort((a, b) => {
        const rank = (name: string) => (pins.includes(name) ? pins.indexOf(name) : pins.length)

        return rank(a) !== rank(b) ? rank(a) - rank(b) : a.localeCompare(b)
    })

    // a playlist shows the cover of the first track that has one
    const playlist_cover = (name: string) =>
        (playlists[name] ?? []).find((track) => cover_of(track))
    // no room on the right half of the window, so the submenu opens leftwards there
    const flip = !!menu && menu.x > window.innerWidth / 2
    const view_title = selection ?? NAV.find((item) => item.id === view)?.label ?? 'Playlists'

    return (
        <div className='shell' onContextMenu={(e) => e.preventDefault()}>
            <div
                className='frame'
                ref={frame}
                style={{
                    gridTemplateColumns: [
                        sidebar_open && column(SIDEBAR_BOUNDS, sidebar_w),
                        '1fr',
                        rail_open && column(RAIL_BOUNDS, rail_w),
                    ]
                        .filter(Boolean)
                        .join(' '),
                }}
            >
                {sidebar_open && (
                    <aside className='sidebar' onContextMenu={context({ kind: 'sidebar' })}>
                        <div className='brand'>
                            <span className='brand-mark'>
                                <i />
                                <i />
                                <i />
                            </span>
                            yugen
                            <button
                                className='icon-btn tiny collapse'
                                title='Hide sidebar'
                                onClick={toggle_sidebar}
                            >
                                <Icon d={ICONS.back} size={16} />
                            </button>
                        </div>

                        <div className='nav-label library-label'>
                            Your Library
                            <button
                                className={`icon-btn tiny${library_menu ? ' on' : ''}`}
                                title='View as'
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

                        {NAV.map((item) => (
                            <button
                                key={item.id}
                                className={`nav-item${view === item.id ? ' active' : ''}`}
                                onClick={() => open_view(item.id)}
                            >
                                <Icon d={item.icon} />
                                {item.label}
                                <span className='nav-count'>{item.count}</span>
                            </button>
                        ))}

                        {playlist_names.length ? (
                            library_view === 'compact-grid' || library_view === 'grid' ? (
                                <div className={`playlist-grid ${library_view}`}>
                                    {playlist_names.map((name) => (
                                        <button
                                            key={name}
                                            className={`tile${
                                                view === 'playlist' && selection === name ? ' active' : ''
                                            }`}
                                            title={name}
                                            onClick={() => open_playlist(name)}
                                            onContextMenu={context({ kind: 'playlist', playlist: name })}
                                        >
                                            {cover(playlist_cover(name) ?? '', 'tile-cover')}
                                            <div className='tile-name ellipsis'>
                                                {pins.includes(name) && (
                                                    <span className='pinned' title='Pinned'>
                                                        <Icon d={ICONS.pin} size={12} fill />
                                                    </span>
                                                )}
                                                {name}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                playlist_names.map((name) => (
                                    <button
                                        key={name}
                                        className={`nav-item playlist-item ${library_view}${
                                            view === 'playlist' && selection === name ? ' active' : ''
                                        }`}
                                        onClick={() => open_playlist(name)}
                                        onContextMenu={context({ kind: 'playlist', playlist: name })}
                                    >
                                        {pins.includes(name) ? (
                                            <span className='pinned' title='Pinned'>
                                                <Icon d={ICONS.pin} size={17} fill />
                                            </span>
                                        ) : (
                                            // compact is text only
                                            library_view === 'list' &&
                                            cover(playlist_cover(name) ?? '', 'playlist-cover')
                                        )}
                                        <span className='ellipsis'>{name}</span>
                                        <span className='nav-count'>{playlists[name].length}</span>
                                    </button>
                                ))
                            )
                        ) : (
                            <p className='nav-hint'>Right-click here to add one.</p>
                        )}

                        <div className='sidebar-foot'>
                            <button className='pill-btn' onClick={fetch_songs} disabled={loading}>
                                <Icon d={ICONS.refresh} size={15} />
                                {loading ? 'Scanning...' : 'Refresh library'}
                            </button>
                        </div>
                    </aside>
                )}

                <main className='main'>
                    <div className='topbar'>
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
                                        placeholder={'Search \\(^o^)/'}
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
                                            title='Clear'
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                set_query('')
                                                set_results([])
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
                                                results.map((result) => (
                                                    <button
                                                        key={result.ref}
                                                        className='result'
                                                        title='Download'
                                                        onClick={() => download(result)}
                                                        disabled={downloading !== null}
                                                    >
                                                        {artwork(result) ? (
                                                            <img src={artwork(result)} alt='' />
                                                        ) : (
                                                            <div className='placeholder'>♪</div>
                                                        )}
                                                        <div className='result-meta'>
                                                            <div className='name ellipsis'>
                                                                {result.title}
                                                            </div>
                                                            <div className='muted'>
                                                                {downloading === result.ref
                                                                    ? 'Downloading...'
                                                                    : source === 'yt'
                                                                      ? 'youtube'
                                                                      : 'soundcloud'}
                                                            </div>
                                                        </div>
                                                        {downloading === result.ref ? (
                                                            <span className='spinner' />
                                                        ) : (
                                                            <Icon d={ICONS.download} size={15} />
                                                        )}
                                                    </button>
                                                ))}
                                        </div>
                                    </div>
                                )}
                            </label>
                        </div>

                    </div>

                    {current && (
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

                    <div className='view-head'>
                        {selection && groups && (
                            <button
                                className='icon-btn back'
                                title='Back'
                                onClick={() => set_selection(null)}
                            >
                                <Icon d={ICONS.back} size={17} />
                            </button>
                        )}
                        <h2 className='section-title ellipsis'>{view_title}</h2>
                        <span className='muted'>
                            {groups && !selection
                                ? `${groups.size} ${view === 'albums' ? 'albums' : 'artists'}`
                                : `${listed.length} tracks`}
                        </span>

                        {view === 'playlist' && (
                            <div className='filter-wrap'>
                                <button
                                    className={`icon-btn filter${filters ? ' on' : ''}`}
                                    title='Sort and view'
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
                                                onClick={() => {
                                                    set_track_layout(option.id)
                                                    save_pref('track_layout', option.id)
                                                }}
                                            >
                                                <span className='ellipsis'>{option.label}</span>
                                                {track_layout === option.id && (
                                                    <Icon d={ICONS.check} size={14} />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {groups && !selection ? (
                        groups.size ? (
                            group_cards(groups, view === 'artists')
                        ) : (
                            <p className='empty'>Nothing to group yet.</p>
                        )
                    ) : listed.length ? (
                        selection ? (
                            view === 'playlist' && track_layout === 'list' ? (
                                track_list(listed)
                            ) : (
                                track_rows(listed)
                            )
                        ) : (
                            <section className='card-row'>
                                {listed.map((name) => (
                                    <div
                                        key={name}
                                        className='album'
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
                    ) : (
                        <p className='empty'>
                            {loading
                                ? 'Scanning your library...'
                                : view === 'liked'
                                  ? 'No liked songs yet.'
                                  : view === 'playlist'
                                    ? 'This playlist is empty. Right-click a track to add it.'
                                    : `No mp3 files found in ${FILE_PATH}`}
                        </p>
                    )}
                </main>

                {rail_open && (
                    <aside className='rightbar'>
                        <div className='rail-head'>
                            <button className='icon-btn tiny' title='Hide panel' onClick={toggle_rail}>
                                <Icon d={ICONS.chevron} size={16} />
                            </button>
                        </div>

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
                )}

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
                    <button className='edge-toggle left' title='Show sidebar' onClick={toggle_sidebar}>
                        <Icon d={ICONS.chevron} size={18} />
                    </button>
                )}

                {/* while cramped the rail has nowhere to go, so no handle is offered */}
                {rail_hidden && !cramped && (
                    <button className='edge-toggle right' title='Show panel' onClick={toggle_rail}>
                        <Icon d={ICONS.back} size={18} />
                    </button>
                )}
            </div>

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

                            {view === 'playlist' && selection && (
                                <button onClick={() => remove_from_playlist(selection, menu.song)}>
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
                                        <button onClick={() => toggle_like(menu.song)}>
                                            <Icon
                                                d={ICONS.heart}
                                                size={15}
                                                fill={liked.has(menu.song)}
                                            />
                                            <span className='ellipsis'>Liked Songs</span>
                                            {liked.has(menu.song) && (
                                                <Icon d={ICONS.check} size={14} />
                                            )}
                                        </button>

                                        {playlist_names.length > 0 && (
                                            <div className='context-sep' />
                                        )}

                                        {playlist_names.map((name) => {
                                            const inside = playlists[name].includes(menu.song)

                                            return (
                                                <button
                                                    key={name}
                                                    onClick={() =>
                                                        inside
                                                            ? remove_from_playlist(name, menu.song)
                                                            : add_to_playlist(name, menu.song)
                                                    }
                                                >
                                                    <Icon d={ICONS.playlist} size={15} />
                                                    <span className='ellipsis'>{name}</span>
                                                    {inside && <Icon d={ICONS.check} size={14} />}
                                                </button>
                                            )
                                        })}

                                        <div className='context-sep' />
                                        <button
                                            onClick={() =>
                                                open_dialog({ mode: 'create', song: menu.song })
                                            }
                                        >
                                            <Icon d={ICONS.plus} size={15} />
                                            <span className='ellipsis'>New playlist</span>
                                        </button>
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

                    {menu.kind === 'playlist' && (
                        <>
                            <div className='context-head ellipsis'>{menu.playlist}</div>
                            <button onClick={() => toggle_pin(menu.playlist)}>
                                <Icon d={ICONS.pin} size={15} />
                                {pins.includes(menu.playlist) ? 'Unpin playlist' : 'Pin playlist'}
                            </button>
                            <button
                                onClick={() =>
                                    open_dialog({ mode: 'rename', playlist: menu.playlist })
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
                        <button onClick={() => open_dialog({ mode: 'create' })}>
                            <Icon d={ICONS.plus} size={15} />
                            New playlist
                        </button>
                    )}
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
                        <h3>
                            {dialog.mode === 'create'
                                ? 'New playlist'
                                : `Rename ${dialog.playlist}`}
                        </h3>
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
                        <div className='dialog-actions'>
                            <button className='pill-btn' onClick={() => set_dialog(null)}>
                                Cancel
                            </button>
                            <button
                                className='pill-btn primary'
                                onClick={commit_dialog}
                                disabled={!draft.trim()}
                            >
                                {dialog.mode === 'create' ? 'Create' : 'Rename'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className='player'>
                <div
                    className={`progress${seeking !== null ? ' dragging' : ''}`}
                    onPointerDown={start_seek}
                    onPointerMove={move_seek}
                    onPointerUp={commit_seek}
                    onPointerCancel={() => set_seeking(null)}
                >
                    <div className='progress-track'>
                        <span
                            style={{
                                width: `${length ? ((seeking ?? position) / length) * 100 : 0}%`,
                            }}
                        />
                    </div>
                </div>

                <div
                    className='playing-info'
                    onContextMenu={current ? song_context(current) : undefined}
                >
                    {current ? (
                        <>
                            {cover(current, '')}
                            <div className='track-meta'>
                                <div className='ellipsis'>{title_of(current)}</div>
                                <div className='muted ellipsis'>{artist_of(current)}</div>
                            </div>
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
                    <button
                        className={`ctrl${shuffle_on ? ' on' : ''}`}
                        title={shuffle_on ? 'Shuffle on' : 'Shuffle off'}
                        onClick={() => set_shuffle_on(!shuffle_on)}
                        disabled={!listed.length}
                    >
                        <Icon d={ICONS.shuffle} size={17} />
                    </button>
                    <button
                        className='ctrl'
                        title='Previous'
                        onClick={() => skip(-1)}
                        disabled={!queue.length}
                    >
                        <Icon d={ICONS.prev} size={18} fill />
                    </button>
                    <button
                        className='ctrl play'
                        title={paused ? 'Resume' : 'Pause'}
                        onClick={toggle_pause}
                        disabled={!current}
                    >
                        <Icon d={paused ? ICONS.play : ICONS.pause} size={16} fill={paused} />
                    </button>
                    <button
                        className='ctrl'
                        title='Next'
                        onClick={() => skip(1)}
                        disabled={!queue.length}
                    >
                        <Icon d={ICONS.next} size={18} fill />
                    </button>
                    <button
                        className={`ctrl${looped ? ' on' : ''}`}
                        title={looped ? 'Loop on' : 'Loop off'}
                        onClick={toggle_loop}
                    >
                        <Icon d={ICONS.loop} size={17} />
                    </button>
                </div>

                <div className='player-right'>
                    <button
                        className='icon-btn tiny'
                        title={`Theme: ${theme}`}
                        onClick={() =>
                            set_theme(
                                theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system',
                            )
                        }
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
                    {format_time(position)} / {format_time(length)}
                </div>
            </div>
        </div>
    )
}
