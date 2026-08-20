#pragma once

// standard library
#include <functional>
#include <string>
#include <string_view>

namespace yugen
{
     /*
      * MPRIS - the D-Bus interface every linux desktop reads a media player
      * through. Without it yugen is invisible to panels, status bars, lock
      * screens and the media keys, no matter what it is playing: they all only
      * ever look at org.mpris.MediaPlayer2.* on the session bus.
      *
      * The service is served over GDBus, which comes in through gio-2.0. That is
      * not a new dependency - webkitgtk already pulls glib into the process - and
      * it means the bus is dispatched by the same glib main loop saucer runs the
      * window on. Nothing here starts a thread.
      *
      * The player state lives in the ui, not in this process: SoundManager knows
      * whether a sound is loaded but not whether it is paused, and the queue,
      * tags and cover art are all on the react side. So the flow is one call in
      * each direction - the ui pushes what it knows through update_track/
      * update_state, and whatever a client asks for comes back out through the
      * handler.
      */
     namespace mpris
     {
          /*
           * A control sent by something outside the process: caelestia's
           * dashboard, playerctl, the media keys. It arrives on the glib main
           * thread, which is also the ui thread, so the handler may call into
           * the webview directly.
           *
           * cmd is one of playpause/play/pause/stop/next/prev/seek/position/
           * volume/raise/quit. arg carries the seconds for seek (a signed
           * offset) and position (absolute), the 0..1 level for volume, and is
           * ignored by the rest.
           */
          using Handler = std::function<void(std::string_view cmd, double arg)>;

          // Claims org.mpris.MediaPlayer2.yugen and publishes the object. Safe to
          // call when there is no session bus: it logs and leaves the player
          // running without the interface rather than failing the launch.
          void start(Handler handler);
          void stop();

          // A new track, or nothing playing at all when file_path is empty. The
          // cover comes in as the same base64 the ui already holds; it is decoded
          // and cached under ~/.cache/yugen/art, since mpris hands out a url and
          // the artwork is otherwise buried in the file's own id3 tags.
          void update_track(const std::string& title, const std::string& artist,
               const std::string& album, const std::string& file_path,
               const std::string& cover_base64);

          // The transport, pushed on every ui change and by the one-second poller
          // that already drives the progress bar.
          void update_state(bool playing, double position, double length, double volume,
               bool can_next, bool can_prev, bool loop, bool shuffle);

          // A jump the ui made on its own (the progress bar, the arrow keys), so
          // that clients move their own bar instead of waiting out the poll.
          void seeked(double position);
     }
}
