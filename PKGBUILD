# Maintainer: Enes Selber <enes.s3lber@gmail.com>

pkgname=yugen-git
pkgver=r25.466e6d4
pkgrel=1
pkgdesc="A desktop music player with YouTube/SoundCloud search, lyrics, and Discord Rich Presence"
arch=('x86_64')
url="https://github.com/k4runa/yugen"
license=('MIT')
# webkitgtk-6.0 and gtk4 are what the binary actually links against - the gtk3
# webkit2gtk-4.1 is a different library and will not satisfy it. ffmpeg is not
# optional either: every download shells out to `yt-dlp -x --audio-format mp3`.
depends=('webkitgtk-6.0'
         'gtk4'
         'libadwaita'
         'taglib'
         'curl'
         'yt-dlp'
         'ffmpeg'
         'hicolor-icon-theme')
makedepends=('cmake' 'ninja' 'npm' 'git')
provides=('yugen')
conflicts=('yugen')
source=("$pkgname::git+https://github.com/k4runa/yugen.git")
sha256sums=('SKIP')

pkgver() {
    cd "$srcdir/$pkgname"
    printf "r%s.%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short HEAD)"
}

build() {
    # the ui bundle has to exist before cmake configures: saucer_embed() globs
    # ui/dist at configure time and bakes it into the executable
    cd "$srcdir/$pkgname/ui"
    npm ci
    npm run build

    cd "$srcdir/$pkgname"
    # the default prefix is /usr/local, which is not where a package belongs
    cmake -B build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr
    cmake --build build
}

package() {
    cd "$srcdir/$pkgname"

    # CMakeLists already installs the binary, the desktop entry and all six
    # icon sizes into the right places, so there is nothing to repeat here
    DESTDIR="$pkgdir" cmake --install build

    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
