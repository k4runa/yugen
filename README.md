# yugen

A desktop music player for Linux. The backend is C++ ([saucer](https://github.com/saucer/saucer) webview + [miniaudio](https://miniaud.io) for playback), the interface is React + TypeScript rendered inside that webview.

## Features

- Plays local mp3 files from a folder, with metadata and embedded cover art read via TagLib
- Search and download tracks from YouTube and SoundCloud (through `yt-dlp`)
- Playlists: create, rename, delete, add/remove tracks
- Liked songs
- Queue with next/prev, shuffle, loop and seeking
- Custom window chrome — native decorations and the WebKit context menu are off, everything is drawn in the UI

## Requirements

- CMake 3.10+, a C++20 compiler, `pkg-config`
- `taglib` (dev package)
- The [saucer](https://github.com/saucer/saucer) system dependencies (WebKitGTK on Linux)
- `yt-dlp` and `ffmpeg` on `PATH` — needed for search and downloads
- Node.js for the UI

`saucer` and `nlohmann/json` are pulled in automatically by CMake's `FetchContent`.

## Building

```sh
cmake -B build -G Ninja && cmake --build build
```

The UI:

```sh
cd ui
npm install
```

## Running

The binary loads the UI from `http://localhost:5173/`, so the Vite dev server has to be up first:

```sh
cd ui && npm run dev
```

then, in another shell:

```sh
./build/yugen
```

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

Similar UI preferences go into `localStorage`, such as window layout, pinned playlists, etc.. (WebKit keeps it under `~/.local/share/yugen`).

## Note

The music folder is currently hardcoded in `ui/src/App.tsx` as `FILE_PATH`. Change it there to point at your own library.