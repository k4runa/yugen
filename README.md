# yugen

A desktop music player for Linux. The backend is C++ ([saucer](https://github.com/saucer/saucer) webview + [miniaudio](https://miniaud.io) for playback), the interface is React + TypeScript rendered inside that webview.

## Features

- Plays local mp3 files from a folder, with metadata and embedded cover art read via TagLib
- Search and download tracks from YouTube and SoundCloud (through `yt-dlp`)
- Playlists: create, rename, delete, add/remove tracks
- Liked songs
- Queue with next/prev, shuffle, loop and seeking
- Lyrics from [lrclib](https://lrclib.net) — a synced sheet follows the track line by line and any line can be clicked to seek there, an unsynced one is shown as plain text
- The cover of the playing track colours the interface: its dominant hue drives every accent, and the artwork itself sits behind the app at an adjustable strength
- Custom window chrome — native decorations, the WebKit context menu and its tooltips are all off, and the menus and tooltips are drawn in the UI instead

## Requirements

- CMake 3.10+, a C++23 compiler, `pkg-config`
- `taglib` and `libcurl` (dev packages)
- The [saucer](https://github.com/saucer/saucer) system dependencies (WebKitGTK on Linux)
- `yt-dlp` and `ffmpeg` on `PATH` — needed for search and downloads
- Node.js for the UI

`saucer`, `saucer/embed`, `nlohmann/json` and the Discord RPC library are pulled in automatically by CMake's `FetchContent`.

Discord rich presence needs no login or token — the running Discord client is talked to over its local socket. It shows the track as a *Listening* activity with a progress bar, and the cover comes from the YouTube thumbnail for downloaded tracks or from an iTunes lookup otherwise, cached in `~/.config/yugen/covers.json`.

## Building

The UI is baked into the executable, so it has to be built first:

```sh
cd ui
npm install
npm run build
```

then:

```sh
cmake -B build -G Ninja && cmake --build build
```

CMake picks up `ui/dist` when it configures and refuses to build without it. Re-running the build re-embeds whatever is in `ui/dist` at that point, so after changing the UI it is `npm run build` and then `cmake --build build`.

## Running

```sh
./build/yugen
```

Nothing else has to be running: the interface is served out of the binary itself.

While working on the UI the dev server is still the faster loop — `cd ui && npm run dev`, and point `UI_ENTRY` in `src/main.cpp` at `http://localhost:5173/` through `set_url` instead of `serve`.

## Layout

```
src/main.cpp       saucer window, and every function exposed to the UI
src/services.cpp   Core / SoundManager / MusicManager
include/services.h
ui/src/App.tsx     the whole interface
```

The three service classes split up as: `Core` handles search, downloads and cover extraction, `SoundManager` handles playback and the queue, `MusicManager` handles playlists and liked songs.

## Data

Playlists and liked songs are stored as JSON under `~/.config/yugen/`:

- `playlists.json`
- `liked_songs.json`

Similar UI preferences go into `localStorage`, such as window layout, pinned playlists, cover tint, etc.. (WebKit keeps it under `~/.local/share/yugen`).

## Note

The music folder is currently hardcoded in `ui/src/App.tsx` as `FILE_PATH`. Change it there to point at your own library.