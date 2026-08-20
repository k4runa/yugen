// standard library
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <format>
#include <fstream>
#include <functional>
#include <mutex>
#include <print>
#include <string>
#include <string_view>

// third party
#include <gio/gio.h>

// project
#include "mpris.h"

namespace fs = std::filesystem;

namespace yugen::mpris
{
     namespace
     {
          constexpr const char* BUS_NAME = "org.mpris.MediaPlayer2.yugen";
          constexpr const char* OBJECT_PATH = "/org/mpris/MediaPlayer2";
          constexpr const char* ROOT_IFACE = "org.mpris.MediaPlayer2";
          constexpr const char* PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
          constexpr const char* PROPS_IFACE = "org.freedesktop.DBus.Properties";

          /*
           * The two interfaces, verbatim from the mpris 2.2 spec. Only the
           * members yugen can actually answer for are here - TrackList and
           * Playlists are whole optional interfaces and are simply absent, which
           * is how a client is told they are not supported.
           */
          constexpr const char* INTROSPECTION = R"xml(
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg direction="in" name="Offset" type="x"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <method name="OpenUri">
      <arg direction="in" name="Uri" type="s"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>
)xml";

          /*
           * Everything the ui has pushed over, plus the bus handles. The mutex is
           * belt and braces: the bindings and the bus callbacks both land on the
           * glib main thread today, but a binding that is ever moved onto a
           * worker would otherwise start tearing the state apart silently.
           */
          std::mutex mtx;

          struct State
          {
               std::string title;
               std::string artist;
               std::string album;
               std::string art_url;
               std::string file_path;
               std::string track_id = "/app/yugen/track/0";

               bool has_track = false;
               bool playing = false;
               bool can_next = false;
               bool can_prev = false;
               bool loop = false;
               bool shuffle = false;

               double length = 0.0;
               double volume = 1.0;

               // the position as it was last pushed, and the monotonic clock
               // reading it was pushed at - see live_position()
               double position = 0.0;
               std::int64_t stamp = 0;

               std::uint64_t serial = 0;
          };

          State state;

          Handler handler;

          GDBusConnection* conn = nullptr;
          GDBusNodeInfo* node = nullptr;
          guint owner_id = 0;
          guint root_reg = 0;
          guint player_reg = 0;

          /*
           * Position is the one property mpris does not signal - clients poll it,
           * and they poll it far more often than the ui pushes. So what is stored
           * is the last reading and when it was taken, and the answer is worked
           * forward from there while the track runs. Without this a progress bar
           * on the other side moves in one-second steps.
           */
          double live_position()
          {
               if(!state.playing) return state.position;

               const double elapsed = static_cast<double>(g_get_monotonic_time() - state.stamp) / 1e6;
               const double now = state.position + elapsed;

               return state.length > 0.0 ? std::min(now, state.length) : now;
          }

          std::int64_t to_micros(double seconds)
          {
               return static_cast<std::int64_t>(seconds * 1e6);
          }

          // Called with the lock held; the dict is what Metadata hands back and
          // what rides along in PropertiesChanged.
          GVariant* build_metadata()
          {
               GVariantBuilder builder;
               g_variant_builder_init(&builder, G_VARIANT_TYPE("a{sv}"));

               if(!state.has_track) return g_variant_builder_end(&builder);

               // an object path, not a string - a plain id here makes some
               // clients drop the whole dict on the floor
               g_variant_builder_add(&builder, "{sv}", "mpris:trackid",
                    g_variant_new_object_path(state.track_id.c_str()));

               if(state.length > 0.0)
               {
                    g_variant_builder_add(&builder, "{sv}", "mpris:length",
                         g_variant_new_int64(to_micros(state.length)));
               }

               if(!state.art_url.empty())
               {
                    g_variant_builder_add(&builder, "{sv}", "mpris:artUrl",
                         g_variant_new_string(state.art_url.c_str()));
               }

               g_variant_builder_add(&builder, "{sv}", "xesam:title",
                    g_variant_new_string(state.title.c_str()));

               if(!state.artist.empty())
               {
                    const char* one[] = {state.artist.c_str(), nullptr};
                    g_variant_builder_add(&builder, "{sv}", "xesam:artist",
                         g_variant_new_strv(one, -1));
               }

               if(!state.album.empty())
               {
                    g_variant_builder_add(&builder, "{sv}", "xesam:album",
                         g_variant_new_string(state.album.c_str()));
               }

               return g_variant_builder_end(&builder);
          }

          const char* playback_status()
          {
               if(!state.has_track) return "Stopped";

               return state.playing ? "Playing" : "Paused";
          }

          // Every property that can move at runtime, sent in one signal. Working
          // out which ones actually changed would save nothing here: the dict is
          // a handful of scalars and it only goes out when the ui reports a real
          // change anyway.
          void emit_player_props()
          {
               if(!conn) return;

               GVariantBuilder changed;
               g_variant_builder_init(&changed, G_VARIANT_TYPE("a{sv}"));

               g_variant_builder_add(&changed, "{sv}", "PlaybackStatus", g_variant_new_string(playback_status()));
               g_variant_builder_add(&changed, "{sv}", "Metadata", build_metadata());
               g_variant_builder_add(&changed, "{sv}", "Volume", g_variant_new_double(state.volume));
               g_variant_builder_add(&changed, "{sv}", "LoopStatus", g_variant_new_string(state.loop ? "Track" : "None"));
               g_variant_builder_add(&changed, "{sv}", "Shuffle", g_variant_new_boolean(state.shuffle));
               g_variant_builder_add(&changed, "{sv}", "CanGoNext", g_variant_new_boolean(state.can_next));
               g_variant_builder_add(&changed, "{sv}", "CanGoPrevious", g_variant_new_boolean(state.can_prev));
               g_variant_builder_add(&changed, "{sv}", "CanPlay", g_variant_new_boolean(state.has_track));
               g_variant_builder_add(&changed, "{sv}", "CanPause", g_variant_new_boolean(state.has_track));
               g_variant_builder_add(&changed, "{sv}", "CanSeek", g_variant_new_boolean(state.has_track && state.length > 0.0));

               GVariantBuilder invalidated;
               g_variant_builder_init(&invalidated, G_VARIANT_TYPE("as"));

               g_dbus_connection_emit_signal(conn, nullptr, OBJECT_PATH, PROPS_IFACE, "PropertiesChanged",
                    g_variant_new("(sa{sv}as)", PLAYER_IFACE, &changed, &invalidated), nullptr);
          }

          // Hands the control to the ui. The lock is dropped first: the handler
          // reaches into the webview, and holding the state mutex across that
          // would deadlock the moment the ui pushed back on the same thread.
          void dispatch(std::string_view cmd, double arg = 0.0)
          {
               Handler copy;

               {
                    std::lock_guard lock{mtx};
                    copy = handler;
               }

               if(copy) copy(cmd, arg);
          }

          /*
           * The bus callbacks.
           */
          void on_method(GDBusConnection*, const gchar*, const gchar*,
               const gchar* iface, const gchar* method, GVariant* params,
               GDBusMethodInvocation* invocation, gpointer)
          {
               const std::string_view name{method};

               if(std::string_view{iface} == ROOT_IFACE)
               {
                    if(name == "Raise") dispatch("raise");
                    else if(name == "Quit") dispatch("quit");

                    g_dbus_method_invocation_return_value(invocation, nullptr);
                    return;
               }

               if(name == "Next") dispatch("next");
               else if(name == "Previous") dispatch("prev");
               else if(name == "Play") dispatch("play");
               else if(name == "Pause") dispatch("pause");
               else if(name == "PlayPause") dispatch("playpause");
               else if(name == "Stop") dispatch("stop");
               else if(name == "Seek")
               {
                    std::int64_t offset = 0;
                    g_variant_get(params, "(x)", &offset);

                    dispatch("seek", static_cast<double>(offset) / 1e6);
               }
               else if(name == "SetPosition")
               {
                    const gchar* track = nullptr;
                    std::int64_t position = 0;
                    g_variant_get(params, "(&ox)", &track, &position);

                    // the id guards against a seek that was aimed at the track
                    // before this one, which is exactly what it is there for
                    std::string current;
                    {
                         std::lock_guard lock{mtx};
                         current = state.track_id;
                    }

                    if(track && current == track) dispatch("position", static_cast<double>(position) / 1e6);
               }

               // OpenUri falls through: yugen plays out of its own library and
               // has nothing to do with a url handed in from outside

               g_dbus_method_invocation_return_value(invocation, nullptr);
          }

          GVariant* on_get_property(GDBusConnection*, const gchar*, const gchar*,
               const gchar* iface, const gchar* property, GError**, gpointer)
          {
               std::lock_guard lock{mtx};

               const std::string_view name{property};

               if(std::string_view{iface} == ROOT_IFACE)
               {
                    if(name == "CanQuit") return g_variant_new_boolean(TRUE);
                    if(name == "CanRaise") return g_variant_new_boolean(TRUE);
                    if(name == "HasTrackList") return g_variant_new_boolean(FALSE);
                    if(name == "Identity") return g_variant_new_string("Yugen");

                    // without this the desktop has no way to tie the bus name to
                    // the installed application, and panels fall back to a
                    // generic icon
                    if(name == "DesktopEntry") return g_variant_new_string("yugen");

                    if(name == "SupportedUriSchemes" || name == "SupportedMimeTypes")
                    {
                         const char* none[] = {nullptr};
                         return g_variant_new_strv(none, -1);
                    }

                    return nullptr;
               }

               if(name == "PlaybackStatus") return g_variant_new_string(playback_status());
               if(name == "LoopStatus") return g_variant_new_string(state.loop ? "Track" : "None");
               if(name == "Shuffle") return g_variant_new_boolean(state.shuffle);
               if(name == "Rate") return g_variant_new_double(1.0);
               if(name == "MinimumRate") return g_variant_new_double(1.0);
               if(name == "MaximumRate") return g_variant_new_double(1.0);
               if(name == "Metadata") return build_metadata();
               if(name == "Volume") return g_variant_new_double(state.volume);
               if(name == "Position") return g_variant_new_int64(to_micros(live_position()));
               if(name == "CanGoNext") return g_variant_new_boolean(state.can_next);
               if(name == "CanGoPrevious") return g_variant_new_boolean(state.can_prev);
               if(name == "CanPlay") return g_variant_new_boolean(state.has_track);
               if(name == "CanPause") return g_variant_new_boolean(state.has_track);
               if(name == "CanSeek") return g_variant_new_boolean(state.has_track && state.length > 0.0);
               if(name == "CanControl") return g_variant_new_boolean(TRUE);

               return nullptr;
          }

          gboolean on_set_property(GDBusConnection*, const gchar*, const gchar*,
               const gchar*, const gchar* property, GVariant* value, GError**, gpointer)
          {
               const std::string_view name{property};

               if(name == "Volume")
               {
                    dispatch("volume", g_variant_get_double(value));
                    return TRUE;
               }

               if(name == "Shuffle")
               {
                    dispatch("shuffle", g_variant_get_boolean(value) ? 1.0 : 0.0);
                    return TRUE;
               }

               if(name == "LoopStatus")
               {
                    // yugen loops the track it is on, and the queue already wraps
                    // by itself, so Playlist has nothing left to turn on and is
                    // taken as off
                    const std::string_view wanted{g_variant_get_string(value, nullptr)};
                    dispatch("loop", wanted == "Track" ? 1.0 : 0.0);

                    return TRUE;
               }

               // Rate is readwrite in the spec but there is one speed here
               return TRUE;
          }

          constexpr GDBusInterfaceVTable VTABLE = {on_method, on_get_property, on_set_property, {nullptr}};

          void on_bus_acquired(GDBusConnection* connection, const gchar*, gpointer)
          {
               GError* error = nullptr;

               conn = connection;

               root_reg = g_dbus_connection_register_object(connection, OBJECT_PATH,
                    g_dbus_node_info_lookup_interface(node, ROOT_IFACE), &VTABLE, nullptr, nullptr, &error);

               if(error)
               {
                    std::println("[ERROR] MPRIS root object: {}", error->message);
                    g_clear_error(&error);
               }

               player_reg = g_dbus_connection_register_object(connection, OBJECT_PATH,
                    g_dbus_node_info_lookup_interface(node, PLAYER_IFACE), &VTABLE, nullptr, nullptr, &error);

               if(error)
               {
                    std::println("[ERROR] MPRIS player object: {}", error->message);
                    g_clear_error(&error);
               }
          }

          void on_name_acquired(GDBusConnection*, const gchar* name, gpointer)
          {
               std::println("[INFO] MPRIS: {}", name);
          }

          // Also what is called when there is no session bus at all, which is why
          // start() can be unconditional: a headless build simply plays on
          // without the interface.
          void on_name_lost(GDBusConnection*, const gchar* name, gpointer)
          {
               std::println("[WARN] MPRIS name unavailable: {}", name);
               conn = nullptr;
          }

          /*
           * The cover. mpris hands out a url and the artwork lives inside the
           * file's own id3 tags, so it has to be written out somewhere a client
           * can open it. The name is the digest of the track path, so a track
           * that comes round again reuses the file it wrote last time instead of
           * growing the directory.
           */
          std::string cache_cover(const std::string& file_path, const std::string& base64)
          {
               if(base64.empty()) return "";

               const fs::path dir = fs::path{g_get_user_cache_dir()} / "yugen" / "art";

               std::error_code ec;
               fs::create_directories(dir, ec);
               if(ec) return "";

               const fs::path out = dir / std::format("{:016x}.jpg", std::hash<std::string>{}(file_path));

               if(!fs::exists(out))
               {
                    gsize len = 0;
                    guchar* raw = g_base64_decode(base64.c_str(), &len);

                    if(!raw) return "";

                    std::ofstream file{out, std::ios::binary};
                    file.write(reinterpret_cast<const char*>(raw), static_cast<std::streamsize>(len));

                    g_free(raw);

                    if(!file) return "";
               }

               gchar* uri = g_filename_to_uri(out.c_str(), nullptr, nullptr);
               if(!uri) return "";

               std::string result{uri};
               g_free(uri);

               return result;
          }
     }

     void start(Handler on_command)
     {
          GError* error = nullptr;
          node = g_dbus_node_info_new_for_xml(INTROSPECTION, &error);

          if(error)
          {
               std::println("[ERROR] MPRIS introspection: {}", error->message);
               g_clear_error(&error);

               return;
          }

          {
               std::lock_guard lock{mtx};
               handler = std::move(on_command);
               state.stamp = g_get_monotonic_time();
          }

          owner_id = g_bus_own_name(G_BUS_TYPE_SESSION, BUS_NAME, G_BUS_NAME_OWNER_FLAGS_NONE,
               on_bus_acquired, on_name_acquired, on_name_lost, nullptr, nullptr);
     }

     void stop()
     {
          if(conn)
          {
               if(root_reg) g_dbus_connection_unregister_object(conn, root_reg);
               if(player_reg) g_dbus_connection_unregister_object(conn, player_reg);
          }

          if(owner_id) g_bus_unown_name(owner_id);
          if(node) g_dbus_node_info_unref(node);

          conn = nullptr;
          node = nullptr;
          owner_id = root_reg = player_reg = 0;

          std::lock_guard lock{mtx};
          handler = nullptr;
     }

     void update_track(const std::string& title, const std::string& artist,
          const std::string& album, const std::string& file_path,
          const std::string& cover_base64)
     {
          // decoding and writing the cover touches the disk, so it happens before
          // the lock rather than under it
          const std::string art = file_path.empty() ? std::string{} : cache_cover(file_path, cover_base64);

          {
               std::lock_guard lock{mtx};

               // the ui pushes this whenever its own copy of the tags is rebuilt,
               // which a library rescan does without a note of the music having
               // changed. bumping the id then would tell every client the track
               // restarted - so the same track over again is not an event
               if(state.has_track == !file_path.empty() && state.file_path == file_path
                    && state.title == title && state.artist == artist && state.album == album
                    && state.art_url == art)
               {
                    return;
               }

               state.has_track = !file_path.empty();
               state.title = title;
               state.artist = artist;
               state.album = album;
               state.art_url = art;
               state.file_path = file_path;

               // a fresh id for a track that really is new, so a client holding
               // one for SetPosition can tell that the music moved on under it
               state.track_id = std::format("/app/yugen/track/{}", ++state.serial);

               state.position = 0.0;
               state.stamp = g_get_monotonic_time();

               if(!state.has_track)
               {
                    state.playing = false;
                    state.length = 0.0;
               }

               emit_player_props();
          }
     }

     void update_state(bool playing, double position, double length, double volume,
          bool can_next, bool can_prev, bool loop, bool shuffle)
     {
          std::lock_guard lock{mtx};

          const bool quiet = state.playing == playing && state.can_next == can_next
               && state.can_prev == can_prev && state.loop == loop && state.shuffle == shuffle
               && std::abs(state.volume - volume) < 0.001 && std::abs(state.length - length) < 0.001;

          state.playing = playing;
          state.length = length;
          state.volume = volume;
          state.can_next = can_next;
          state.can_prev = can_prev;
          state.loop = loop;
          state.shuffle = shuffle;

          state.position = position;
          state.stamp = g_get_monotonic_time();

          // the poller calls this every second and only the position has usually
          // moved, which is the one thing mpris never signals - so a tick where
          // nothing else changed goes no further than the stored state
          if(!quiet) emit_player_props();
     }

     void seeked(double position)
     {
          std::lock_guard lock{mtx};

          state.position = position;
          state.stamp = g_get_monotonic_time();

          if(!conn) return;

          g_dbus_connection_emit_signal(conn, nullptr, OBJECT_PATH, PLAYER_IFACE, "Seeked",
               g_variant_new("(x)", to_micros(position)), nullptr);
     }
}
