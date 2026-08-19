#define MINIAUDIO_IMPLEMENTATION

#ifndef APPLICATION_ID
#define APPLICATION_ID 1539558939463786516
#endif

// standard library
#include <cstdint>
#include <filesystem>
#include <print>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

// third party
#include <coco/stray/stray.hpp>
#include <saucer/embedded/all.hpp>
#include <saucer/app.hpp>
#include <saucer/executor.hpp>
#include <saucer/smartview.hpp>
#include <saucer/window.hpp>

// project
#include "miniaudio.h"
#include "services.h"

namespace fs = std::filesystem;

using mm = yugen::MusicManager;
using sm = yugen::SoundManager;
using co = yugen::Core;

namespace
{
     // the entry point of the bundle baked in by saucer_embed(), served from
     // memory rather than fetched over http - there is no server to point at.
     // the leading slash matters: it becomes the path of a saucer:// url, and
     // the embedded files are keyed by exactly that path
     constexpr const char* UI_ENTRY = "/index.html";

     constexpr int WINDOW_MIN_WIDTH = 720;
     constexpr int WINDOW_MIN_HEIGHT = 440;

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
     struct async_binding : async_binding<decltype(&Fn::operator())>
     {
     };

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

     window->set_title("yugen");

     // the webkit menu can't be edited, so it is turned off and drawn in the ui instead
     webview->set_context_menu(false);

     yugen::start_discord(APPLICATION_ID);

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

     /*
      * Discord. Both of these only touch a flag: the presence thread is started
      * at launch and keeps running either way, it just stops being told about
      * track changes while sharing is off. The getter is what the ui reads on
      * startup to draw the switch in the right position, since the setting lives
      * on this side and not in the page.
      */
     webview->expose("set_activity", [](bool state) {
          yugen::set_activity(state);
          std::println("[INFO] Share activity on discord: {}", state);
     });

     webview->expose("get_activity", [] {
          return yugen::get_activity();
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

     yugen::stop_discord();
     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "yugen"})->run(start);
}
