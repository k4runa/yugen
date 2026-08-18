import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const FILE_PATH = '/home/g4lice/Musics/'

type Theme = 'system' | 'light' | 'dark'
type View = 'library' | 'liked' | 'albums' | 'artists'

type SearchResult = {
    title: string
    id: string
}

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
    search(query: string, count: number): Promise<string[]>
    download(id: string, path: string): Promise<string>
    shuffle(songs: string[]): Promise<string[]>
    next(): Promise<string>
    prev(): Promise<string>
    is_finished(): Promise<boolean>
    seek(position: number): Promise<void>
    delete_song(path: string): Promise<void>
    get_liked_songs(): Promise<string[]>
    like_song(name: string): Promise<void>
    unlike_song(name: string): Promise<void>
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
    const [shuffled, set_shuffled] = useState<{ key: string; order: string[] } | null>(null)

    const [menu, set_menu] = useState<{ x: number; y: number; song: string } | null>(null)

    const [query, set_query] = useState('')
    const [searching, set_searching] = useState(false)
    const [results, set_results] = useState<SearchResult[]>([])
    const [downloading, set_downloading] = useState<string | null>(null)

    useEffect(() => {
        // with no attribute the stylesheet falls back to prefers-color-scheme
        if (theme === 'system') delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = theme
    }, [theme])

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

    async function remove_song(name: string) {
        await bridge().delete_song(FILE_PATH + name)

        if (current === name) set_current(null)

        await fetch_songs()
        await sync_liked()
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
        await bridge().toggle_loop(looped)
        set_looped(!looped)
    }

    function skip(offset: number) {
        if (!queue.length) return

        const index = current ? queue.indexOf(current) : -1
        play_music(queue[(index + offset + queue.length) % queue.length])
    }

    async function search() {
        if (!query.trim()) return

        set_searching(true)
        // yt-dlp prints a flat [title, id, title, id, ...] list
        const flat: string[] = await bridge().search(query, 10)

        set_results(
            Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => ({
                title: flat[i * 2],
                id: flat[i * 2 + 1],
            }))
                // a flat search also returns channels and playlists; only video ids are 11 chars
                .filter((result) => /^[\w-]{11}$/.test(result.id)),
        )
        set_searching(false)
    }

    async function download(id: string) {
        set_downloading(id)
        await bridge().download(id, FILE_PATH)
        set_downloading(null)
        await fetch_songs()
        await sync_liked()
    }

    function open_view(next: View) {
        set_view(next)
        set_selection(null)
    }

    const title_of = (name: string) => metadata_map[name]?.[0] || name.replace(/\.mp3$/i, '')
    const artist_of = (name: string) => metadata_map[name]?.[1] || 'Unknown artist'
    const album_of = (name: string) => metadata_map[name]?.[2] || 'Unknown album'
    const cover_of = (name: string) => covers_map[name]

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

    // the current queue: what prev/next walks through
    const listed = selection
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
        { id: 'library', label: 'Library', icon: ICONS.library, count: songs.length },
        { id: 'liked', label: 'Liked Songs', icon: ICONS.heart, count: liked_songs.length },
        { id: 'albums', label: 'Albums', icon: ICONS.album, count: albums.size },
        { id: 'artists', label: 'Artists', icon: ICONS.artist, count: artists.size },
    ]

    // right-click target: the native webkit menu is off, this one replaces it
    const context = (name: string) => (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()

        set_menu({
            x: Math.min(e.clientX, window.innerWidth - 190),
            y: Math.min(e.clientY, window.innerHeight - 140),
            song: name,
        })
    }

    // local wrappers so call sites stay short
    const cover = (name: string, className: string) => (
        <Cover data={cover_of(name)} alt={title_of(name)} className={className} />
    )

    const heart = (name: string, className?: string, size?: number) => (
        <Heart liked={liked.has(name)} on_toggle={() => toggle_like(name)} className={className} size={size} />
    )

    function track_rows(names: string[]) {
        return (
            <div className='track-rows'>
                {names.map((name, i) => (
                    <div
                        key={name}
                        className='track'
                        onClick={() => play_music(name)}
                        onContextMenu={context(name)}
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

    const view_title = selection ?? NAV.find((item) => item.id === view)!.label

    return (
        <div className='shell' onContextMenu={(e) => e.preventDefault()}>
            <div className='frame glass'>
                <aside className='sidebar'>
                    <div className='brand'>
                        <span className='brand-mark'>
                            <i />
                            <i />
                            <i />
                        </span>
                        yugen
                    </div>

                    <div className='nav-label'>My music</div>
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

                    <div className='sidebar-foot'>
                        <button className='pill-btn' onClick={fetch_songs} disabled={loading}>
                            <Icon d={ICONS.refresh} size={15} />
                            {loading ? 'Scanning...' : 'Refresh library'}
                        </button>
                    </div>
                </aside>

                <main className='main'>
                    <div className='topbar'>
                        <label className='search'>
                            <Icon d={ICONS.search} size={15} />
                            <input
                                placeholder='Search on youtube...'
                                value={query}
                                onChange={(e) => set_query(e.currentTarget.value)}
                                onKeyDown={(e) => e.key === 'Enter' && search()}
                            />
                        </label>

                        <button
                            className='icon-btn'
                            title={`Theme: ${theme}`}
                            onClick={() =>
                                set_theme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')
                            }
                        >
                            <Icon
                                d={theme === 'system' ? ICONS.system : theme === 'light' ? ICONS.sun : ICONS.moon}
                            />
                        </button>
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
                                                onContextMenu={context(name)}
                                            >
                                                <div className='track-meta'>
                                                    <div className='name ellipsis'>{title_of(name)}</div>
                                                    <div className='muted ellipsis'>{artist_of(name)}</div>
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
                        {selection && (
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
                    </div>

                    {groups && !selection ? (
                        groups.size ? (
                            group_cards(groups, view === 'artists')
                        ) : (
                            <p className='empty'>Nothing to group yet.</p>
                        )
                    ) : listed.length ? (
                        selection ? (
                            track_rows(listed)
                        ) : (
                            <section className='card-row'>
                                {listed.map((name) => (
                                    <div
                                        key={name}
                                        className='album'
                                        onClick={() => play_music(name)}
                                        onContextMenu={context(name)}
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
                                  : `No mp3 files found in ${FILE_PATH}`}
                        </p>
                    )}
                </main>

                <aside className='rightbar'>
                    <section>
                        <h2 className='section-title'>Search Results</h2>

                        {searching && <p className='muted'>Searching youtube...</p>}
                        {!searching && !results.length && (
                            <p className='muted'>Search youtube to download a track.</p>
                        )}

                        {results.map((result) => (
                            <button
                                key={result.id}
                                className='result'
                                title='Download'
                                onClick={() => download(result.id)}
                                disabled={downloading !== null}
                            >
                                <img src={`https://img.youtube.com/vi/${result.id}/mqdefault.jpg`} alt='' />
                                <div className='result-meta'>
                                    <div className='name ellipsis'>{result.title}</div>
                                    <div className='muted'>
                                        {downloading === result.id ? 'Downloading...' : 'youtube'}
                                    </div>
                                </div>
                                {downloading === result.id ? (
                                    <span className='spinner' />
                                ) : (
                                    <Icon d={ICONS.download} size={15} />
                                )}
                            </button>
                        ))}
                    </section>

                    {liked_songs.length > 0 && (
                        <section>
                            <h2 className='section-title'>Liked Songs</h2>
                            {liked_songs.map((name) => (
                                <button
                                    key={name}
                                    className='result'
                                    onClick={() => play_music(name)}
                                    onContextMenu={context(name)}
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
            </div>

            {menu && (
                <div className='context-menu glass' style={{ left: menu.x, top: menu.y }}>
                    <div className='context-head ellipsis'>{title_of(menu.song)}</div>
                    <button onClick={() => play_music(menu.song)}>
                        <Icon d={ICONS.play} size={15} fill />
                        Play
                    </button>
                    <button onClick={() => toggle_like(menu.song)}>
                        <Icon d={ICONS.heart} size={15} fill={liked.has(menu.song)} />
                        {liked.has(menu.song) ? 'Remove from liked' : 'Add to liked'}
                    </button>
                    <button className='danger' onClick={() => remove_song(menu.song)}>
                        <Icon d={ICONS.trash} size={15} />
                        Delete from disk
                    </button>
                </div>
            )}

            <div className='player glass'>
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
                    onContextMenu={current ? context(current) : undefined}
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
                    {format_time(position)} / {format_time(length)}
                </div>
            </div>
        </div>
    )
}
