# yugen

A desktop music player for Linux. Plays local mp3 files, searches and downloads
tracks from YouTube and SoundCloud through `yt-dlp`, keeps playlists and liked
songs, shows synced lyrics from [lrclib](https://lrclib.net), and tints itself
with the cover art of whatever is playing.

It publishes itself over MPRIS, so the track and the transport show up wherever
the desktop looks for a player — panels and shell dashboards, the lock screen,
`playerctl`, and the media keys.

The backend is C++ — [saucer](https://github.com/saucer/saucer) for the webview,
[miniaudio](https://miniaud.io) for playback, TagLib for metadata. The interface
is React + TypeScript, built into a bundle that is baked straight into the
executable, so the binary is all there is to run.

## Install

```sh
curl -sL https://raw.githubusercontent.com/k4runa/yugen/master/install.sh | bash
```

It offers two options. `--appimage` and `--source` skip the prompt.

**AppImage** downloads the bundle into `~/.local/bin` and writes a launcher
entry. Nothing is installed system-wide and root is never asked for: WebKitGTK,
`yt-dlp` and `ffmpeg` all travel inside the bundle. The two things it cannot
carry are glibc, so the host has to be at least as new as the machine that built
the release, and the kernel's unprivileged user namespaces, which the bundled
WebKit needs to reach its own helper processes.

**From source** installs the toolchain and the dependencies for your distro,
puts `yt-dlp` on the nightly channel, builds, and installs into `/usr/local`.

The AppImage can also be built locally with
[`packaging/appimage/build.sh`](packaging/appimage/build.sh). Build it inside an
old base image if you mean to hand it to anyone else — the glibc of the build
host is the floor for every machine that runs it.

## Building

Needs CMake 3.10+, a C++23 compiler, `pkg-config`, Node.js, the dev packages for
`taglib`, `libcurl` and `glib2` (for GDBus, which serves the MPRIS interface),
WebKitGTK, and `yt-dlp` + `ffmpeg` on `PATH`. Everything else is fetched by
CMake.

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

The music folder comes from the backend's `get_file_path` binding, which points
at `~/Music` and creates it if it is not there. Playlists and liked songs live
in `~/.config/yugen/`.

## License

[LICENSE](LICENSE) — MIT
