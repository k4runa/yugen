#define MINIAUDIO_IMPLEMENTATION

#ifndef APPLICATION_ID
#define APPLICATION_ID 1539558939463786516
#endif

// standard library
#include <cstdint>
#include <filesystem>
#include <print>
#include <string>
#include <string_view>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>
#include <cstddef>
#include <pwd.h>
#include <unistd.h>

// third party
#include <coco/stray/stray.hpp>
#include <saucer/embedded/all.hpp>
#include <saucer/app.hpp>
#include <saucer/executor.hpp>
#include <saucer/smartview.hpp>
#include <saucer/window.hpp>

// project
#include "miniaudio.h"
#include "mpris.h"
#include "services.h"

namespace fs = std::filesystem;

using mm = yugen::MusicManager;
using sm = yugen::SoundManager;
using co = yugen::Core;
using pf = yugen::Profile;

namespace
{
     // the entry point of the bundle baked in by saucer_embed(), served from
     // memory rather than fetched over http - there is no server to point at.
     // the leading slash matters: it becomes the path of a saucer:// url, and
     // the embedded files are keyed by exactly that path
     constexpr const char* UI_ENTRY = "/index.html";

     constexpr int WINDOW_MIN_WIDTH = 900;
     constexpr int WINDOW_MIN_HEIGHT = 720;

     /*
      * expose_async
      *
      * Anything that touches the disk, the network or yt-dlp would freeze the
      * window if it ran on the ui thread, so it is moved to a worker thread and
      * answered later through saucer's executor, which resolves the javascript
      * promise on the other side of the bridge.
      *
      * That wrapping is the same every time, so instead of repeating it in every
      * binding it is written once here and the bindings only say what the work is:
      *
      *     expose_async(webview, "next", [] { return sm::next_song(); });
      *
      * How it works: async_binding reads the argument and return types straight
      * off the lambda's operator(), and make_async builds a second lambda that
      * takes those same arguments plus the executor saucer wants as the last
      * parameter. Whatever the lambda returns is what the promise resolves with;
      * returning void resolves an empty one.
      */
     template <typename Result, typename... Args, typename Fn>
     auto make_async(Fn fn)
     {
          return [fn = std::move(fn)](Args... args, saucer::executor<Result> exec)
          {
               std::thread worker{[fn, ...args = std::move(args), exec = std::move(exec)]() mutable
               {
                    if constexpr(std::is_void_v<Result>)
                    {
                         fn(std::move(args)...);
                         exec.resolve();
                    }
                    else
                    {
                         exec.resolve(fn(std::move(args)...));
                    }
               }};

               worker.detach();
          };
     }

     // reads the argument and return types back off the lambda's call operator
     template <typename Fn>
     struct async_binding : async_binding<decltype(&Fn::operator())> { };

     template <typename Class, typename Result, typename... Args>
     struct async_binding<Result (Class::*)(Args...) const>
     {
          template <typename Fn>
          static auto wrap(Fn fn)
          {
               return make_async<Result, Args...>(std::move(fn));
          }
     };

     void expose_async(auto& webview, const std::string& name, auto fn)
     {
          webview->expose(name, async_binding<decltype(fn)>::wrap(std::move(fn)));
     }

     /*
      * run_js
      *
      * execute() takes a saucer::cstring_view, and building one is enough for gcc
      * to escalate the enclosing lambda into an immediate function - which then
      * cannot be stored in the std::function the mpris handler is. Wrapping the
      * call in a plain function keeps that out of the lambda; it has to stay a
      * non-template so the escalation cannot simply follow it here.
      */
     void run_js(saucer::webview& view, const std::string& script)
     {
          view.execute(script);
     }
}

coco::stray start(saucer::application* app)
{
     auto window = saucer::window::create(app).value();
     auto webview = saucer::smartview::create({.window = window});

     ma_engine engine;

     const ma_result res = ma_engine_init(nullptr, &engine);
     if(res != MA_SUCCESS)
     {
          std::println("[ERROR] Engine init failed: {}", static_cast<int>(res));
     }

     fs::create_directories(yugen::data_dir());
     // after the directory, not before: init() writes the last.fm key into it
     // and an ofstream will not make the path itself
     mm::init();

     window->set_title("yugen");

     // the webkit menu can't be edited, so it is turned off and drawn in the ui instead
     webview->set_context_menu(false);

     yugen::start_discord(APPLICATION_ID);

     /*
      * MPRIS. The interface is what every panel, lock screen and media key on
      * the desktop reads a player through, so without it yugen plays to itself:
      * nothing outside the process can see the track or reach the transport.
      *
      * The state it publishes is pushed in by the ui through the three bindings
      * below, and the controls that come back the other way are handed to the
      * page rather than to SoundManager. That is not a detour - the queue, the
      * paused flag and the tags all live on the react side, and calling the
      * backend behind its back would leave the window showing the wrong thing.
      *
      * The callback runs on the glib main loop, which is the same thread the
      * window is on, and execute() is thread safe regardless.
      */
     yugen::mpris::start([&](std::string_view cmd, double arg) {
          if(cmd == "raise")
          {
               window->show();
               window->set_minimized(false);
               window->focus();

               return;
          }

          if(cmd == "quit")
          {
               app->quit();
               return;
          }

          // the page registers the receiving end on the way up; until it does,
          // the optional call simply drops the control
          const std::string call = "window.__yugen_mpris?.('" + std::string{cmd} + "', " + std::to_string(arg) + ")";

          run_js(*webview, call);
     });

     /*
      * Playback control. miniaudio only flips state on a sound that is already
      * loaded, so these return in microseconds and answer on the ui thread
      * directly. seek() is the exception - it can pull new frames from the file.
      */
     webview->expose("play_music", [&](const std::string& file_path, const std::string& title,
          const std::string& artist, const std::string& album) {
          sm::play(&engine, file_path, title, artist, album);
     });

     webview->expose("resume", [] {
          sm::resume();
     });

     webview->expose("stop", [] {
          sm::stop();
     });

     webview->expose("toggle_loop", [](bool state) {
          std::println("[INFO] Toggle loop: {}", state);
          sm::toggle_loop();
     });

     expose_async(webview, "seek", [](float position) {
          sm::seek(position);
     });
     
     expose_async(webview, "get_playlist_count", []() {
          return co::get_playlist_count();
     });

     // polled by the ui while a track runs, so these stay synchronous and cheap
     webview->expose("get_position", []() -> float {
          return sm::get_pos();
     });

     webview->expose("get_length", []() -> float {
          return sm::get_len();
     });

     webview->expose("is_finished", []() -> bool {
          return sm::is_finished();
     });

     /*
      * Queue. next/prev only return the file name of the neighbouring track;
      * the ui decides what to do with it and calls play_music itself.
      */
     expose_async(webview, "next", [] {
          return sm::next_song();
     });

     expose_async(webview, "prev", [] {
          return sm::prev_song();
     });

     expose_async(webview, "shuffle", [](std::vector<std::string> songs) {
          std::println("[INFO] Shuffled songs");
          return mm::shuffle_songs(songs);
     });

     /*
      * The library on disk. These read files, so they are called once per track
      * when a folder is opened and the results are kept on the ui side.
      */
     webview->expose("fetch_songs", [](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Fetching songs on {}", file_path);
          return sm::fetch_songs(file_path);
     });

     webview->expose("get_metadata", [](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Get metadata: {}", file_path);
          return sm::get_metadata(file_path);
     });

     webview->expose("get_cover", [](const std::string& file_path) -> std::string {
          std::println("[INFO] Get cover: {}", file_path);
          return co::get_cover(file_path);
     });

     expose_async(webview, "delete_song", [](std::string file_path) {
          std::println("[INFO] Deleted song: {}", file_path);
          sm::delete_song(file_path);
     });

     /*
      * Search and download. Every one of these starts a yt-dlp process and waits
      * for it, which takes seconds for a search and minutes for a download, so
      * they all go through expose_async.
      */
     expose_async(webview, "search_yt", [](std::string query, int count) {
          std::println("[INFO] Searching on youtube - query: {}", query);
          return co::search_youtube(query, count);
     });

     expose_async(webview, "search_sc", [](std::string query, int count) {
          std::println("[INFO] Searching on sound cloud - query: {}", query);
          return co::search_sound_cloud(query, count);
     });

     expose_async(webview, "download_yt", [](std::string id, std::string output_path) {
          std::println("[INFO] Download from youtube - id: {}", id);
          return co::download_from_yt(id, output_path);
     });

     expose_async(webview, "download_sc", [](std::string url, std::string output_path) {
          std::println("[INFO] Download from sound cloud - url: {}", url);
          return co::download_from_sc(url, output_path);
     });

     /*
      * Liked songs, stored as a flat array of file names in liked_songs.json.
      */
     expose_async(webview, "get_liked_songs", [] {
          std::println("[INFO] Fetched liked songs");
          return mm::get_liked_songs();
     });

     expose_async(webview, "like_song", [](std::string song_name) {
          std::println("[INFO] Liked song: {}", song_name);
          mm::like_song(song_name);
     });

     expose_async(webview, "unlike_song", [](std::string song_name) {
          std::println("[INFO] Unliked song: {}", song_name);
          mm::unlike_song(song_name);
     });

     /*
      * Playlists. The sidebar asks for the names, opening one asks for its tracks,
      * and the mutating calls answer with a bool the ui uses to decide whether to
      * refresh the list.
      */
     expose_async(webview, "get_playlists", [] {
          return mm::get_playlists();
     });

     expose_async(webview, "get_playlist", [](std::string playlist_name) {
          return mm::get_playlist(playlist_name);
     });

     expose_async(webview, "create_playlist", [](std::string playlist_name) {
          std::println("[INFO] Create playlist: {}", playlist_name);
          return mm::create_playlist(playlist_name);
     });

     expose_async(webview, "delete_playlist", [](std::string playlist_name) {
          std::println("[INFO] Delete playlist: {}", playlist_name);
          return mm::delete_playlist(playlist_name);
     });

     expose_async(webview, "rename_playlist", [](std::string playlist_name, std::string new_playlist_name) {
          std::println("[INFO] Rename playlist: {} -> {}", playlist_name, new_playlist_name);
          return mm::rename_playlist(playlist_name, new_playlist_name);
     });

     expose_async(webview, "add_to_playlist", [](std::string playlist_name, std::string file_path) {
          std::println("[INFO] Add {} to {}", file_path, playlist_name);
          return mm::add_to_playlist(playlist_name, file_path);
     });

     expose_async(webview, "remove_from_playlist", [](std::string playlist_name, std::string file_path) {
          std::println("[INFO] Delete {} from {}", file_path, playlist_name);
          return mm::remove_from_playlist(playlist_name, file_path);
     });

     /*
      * Lyrics, fetched from lrclib. The panel gets the raw sheet back and does
      * its own parsing, timed or not.
      */
     expose_async(webview, "get_lyrics", [](std::string title, std::string artist) {
          std::println("[INFO] Fetching lyrics for {} - {}", title, artist);
          return co::get_lyrics(title, artist);
     });

     expose_async(webview, "get_username", [](){
          return pf::get_username();
     });

     expose_async(webview, "get_biography", [](){
          return pf::get_biography();
     });
     
     expose_async(webview, "get_profile_picture", [](){
          return pf::get_profile_picture();
     });
     
     expose_async(webview, "get_favorite_songs", [](){
          return pf::get_favorite_songs();
     });

     expose_async(webview, "set_username", [](std::string username){
          return pf::set_username(username);
     });
     
     expose_async(webview, "set_biography", [](std::string bio){
          return pf::set_biography(bio);
     });

     expose_async(webview, "set_profile_picture", [](std::string img_path){
          return pf::set_profile_picture(img_path);
     });
     
     expose_async(webview, "add_favorite_song", [](yugen::TrackInfo track){
          return pf::add_favorite_song(track);
     });
     
     expose_async(webview, "remove_from_favorites", [](std::string file_path){
          return pf::remove_from_favorites(file_path);
     });
     /*
      * Discord. Both of these only touch a flag: the presence thread is started
      * at launch and keeps running either way, it just stops being told about
      * track changes while sharing is off. The getter is what the ui reads on
      * startup to draw the switch in the right position, since the setting lives
      * on this side and not in the page.
      */
     webview->expose("set_activity", [](bool state) -> void {
          yugen::set_activity(state);
          std::println("[INFO] Share activity on discord: {}", state);
     });

     webview->expose("set_volume", [](float vol) -> void {
          sm::set_volume(vol);
     });

     /*
      * The ui half of MPRIS. mpris_track carries the cover as the same base64
      * the page already holds, so it is only called when the track changes;
      * mpris_state rides the one second poller that already drives the progress
      * bar, and mpris_seeked is for the jumps that poller would otherwise
      * smear over a second.
      */
     webview->expose("mpris_track", [](const std::string& title, const std::string& artist,
          const std::string& album, const std::string& file_path, const std::string& cover) {
          yugen::mpris::update_track(title, artist, album, file_path, cover);
     });

     webview->expose("mpris_state", [](bool playing, float position, float length, float volume,
          bool can_next, bool can_prev, bool loop, bool shuffle) {
          yugen::mpris::update_state(playing, position, length, volume, can_next, can_prev, loop, shuffle);
     });

     webview->expose("mpris_seeked", [](float position) {
          yugen::mpris::seeked(position);
     });

     webview->expose("get_activity", [] ->bool {
          return yugen::get_activity();
     });

     webview->expose("load_volume", [] -> float {
          return sm::load_volume();
     });

     webview->expose("get_file_path", [] -> std::string{
          passwd* p = getpwuid(getuid());
          if(p) {
               fs::create_directories(std::string(p->pw_dir) + "/Music" );
               return std::string(p->pw_dir) + "/Music";
          }
          return "";
     });

     // both of these end in a request to last.fm, so they go out async: the ui
     // fires a handful at a time and the window stays live through them
     expose_async(webview, "get_similar", [](std::string file_path, int limit){
          return mm::get_similar(file_path, limit);
     });

     expose_async(webview, "get_track_cover", [](std::string artist, std::string track_name){
          return mm::get_track_cover(artist, track_name);
     });

     expose_async(webview,"get_playlist_cover", [](std::string playlist_name){
          return mm::get_playlist_cover(playlist_name);
     });

     expose_async(webview,"set_playlist_cover", [](std::string playlist_name, std::string base64_pic){
          return mm::set_or_update_playlist_cover(playlist_name, base64_pic);
     });


     /*
      * The window is set up last, once every binding exists, so the page cannot
      * load and call into a function that has not been exposed yet.
      */
     webview->embed(saucer::embedded::all());
     webview->serve(UI_ENTRY);
     window->set_min_size({WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT});
     window->set_maximized(true);
     window->set_decorations(saucer::window::decoration::none);
     window->show();

     co_await app->finish();

     yugen::mpris::stop();
     yugen::stop_discord();
     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "yugen"})->run(start);
}
