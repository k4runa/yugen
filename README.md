# yugen

A desktop music player for Linux. Plays local mp3 files, searches and downloads
tracks from YouTube and SoundCloud through `yt-dlp`, keeps playlists and liked
songs, shows synced lyrics from [lrclib](https://lrclib.net), and tints itself
with the cover art of whatever is playing.

The backend is C++ — [saucer](https://github.com/saucer/saucer) for the webview,
[miniaudio](https://miniaud.io) for playback, TagLib for metadata. The interface
is React + TypeScript, built into a bundle that is baked straight into the
executable, so the binary is all there is to run.

## Download

A prebuilt AppImage is on the [releases page](https://github.com/k4runa/yugen/releases):

```sh
wget https://github.com/k4runa/yugen/releases/download/v1.0.0/Yugen-x86_64.AppImage
chmod +x Yugen-x86_64.AppImage
./Yugen-x86_64.AppImage
```

It still needs `yt-dlp` and `ffmpeg` on `PATH` for search and downloads.

## Building

Needs CMake 3.10+, a C++23 compiler, `pkg-config`, Node.js, the dev packages for
`taglib` and `libcurl`, WebKitGTK, and `yt-dlp` + `ffmpeg` on `PATH`. Everything
else is fetched by CMake.

The UI has to be built first — CMake embeds `ui/dist` when it configures and
will not build without it:

```sh
cd ui
npm install
npm run build
cd ..

cmake -B build -G Ninja && cmake --build build
```

After changing the UI, re-run `npm run build` and then `cmake --build build`.

## Running

```sh
./build/yugen
```

Or install it system-wide, which also drops in the desktop entry and icons:

```sh
sudo cmake --install build
```

The music folder is hardcoded in `ui/src/App.tsx` as `FILE_PATH` — point it at
your own library. Playlists and liked songs live in `~/.config/yugen/`.

## License

[LICENSE](LICENSE) — MIT
