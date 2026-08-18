
#define MINIAUDIO_IMPLEMENTATION

#include "coco/stray/stray.hpp"
#include "saucer/app.hpp"
#include "saucer/window.hpp"
#include "services.h"
#include "miniaudio.h"
#include "saucer/executor.hpp"

#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#include <saucer/smartview.hpp>
#include <string>
#include <print>
#include <filesystem>


namespace fs = std::filesystem;
using mm = yugen::MusicManager;
using sm = yugen::SoundManager;
using co = yugen::Core;

coco::stray start(saucer::application *app)
{
     auto window = saucer::window::create(app).value();
     auto webview = saucer::smartview::create({.window = window});

     ma_engine engine;

     ma_result res = ma_engine_init(NULL, &engine);
     if(res != MA_SUCCESS) {
          std::println("[ERROR]: Engine init failed: {}", (int)(res));
     }

     fs::create_directories(yugen::data_dir());


     window->set_title("yugen");

     // the webkit menu can't be edited, so it is turned off and drawn in the ui instead
     webview->set_context_menu(false);

     webview->expose("fetch_songs", [&](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Fetching songs on {}", file_path);
          const auto res = sm::fetch_songs(file_path); 
          return res;
     });
     
     webview->expose("play_music", [&](const std::string& file_path) {
          sm::play(&engine, file_path);
     });

     webview->expose("get_position", []() -> float {
          return sm::get_pos();
     });

     webview->expose("get_length", []() -> float {
          return sm::get_len();
     });
     
     webview->expose("stop", []() {
          sm::stop();
     });

     webview->expose("resume", []() {
          sm::resume();
     });

     webview->expose("toggle_loop", [](bool state){
          std::println("[INFO]: Toggle loop: {}", state);
          sm::toggle_loop();
     });

     webview->expose("get_metadata", [&](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Get metadata: {}", file_path);
          return sm::get_metadata(file_path);
     });

     webview->expose("get_cover", [&](const std::string& file_path) -> std::string {
          std::println("[INFO] Get cover: {}", file_path);
          return co::get_cover(file_path);
     });

     webview->expose("search_yt", [&](std::string query, int count, saucer::executor<std::vector<std::string>> exec) {
          std::println("[INFO] Searching on youtube - query: {}", query);
          std::thread t{[query, count, exec = std::move(exec)]() {
               auto results = co::search_youtube(query, count);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("search_sc", [&](std::string query, int count, saucer::executor<std::vector<std::string>> exec) {
          std::println("[INFO] Searching on sound cloud - query: {}", query);
          std::thread t{[query, count, exec = std::move(exec)]() {
               auto results = co::search_sound_cloud(query, count);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("download_yt", [&](std::string id,  std::string output_path, saucer::executor<std::string> exec) {
          std::println("[INFO] Download from youtube - id: {}", id);
          std::thread t{[id, output_path, exec = std::move(exec)]() {
               auto results = co::download_from_yt(id, output_path);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("download_sc", [&](std::string url,  std::string output_path, saucer::executor<std::string> exec) {
          std::println("[INFO] Download from sound cloud - url: {}", url);
          std::thread t{[url, output_path, exec = std::move(exec)]() {
               auto results = co::download_from_sc(url, output_path);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("get_liked_songs", [&](saucer::executor<std::vector<std::string>> exec) {
          std::println("[INFO] Fetched liked songs");
          std::thread t{[exec = std::move(exec)]() {
               auto results = mm::get_liked_songs();
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("like_song", [&](std::string song_name, saucer::executor<void> exec) {
          std::println("[INFO] Liked song: {}", song_name);
          std::thread t{[song_name, exec = std::move(exec)]() {
               mm::like_song(song_name);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("unlike_song", [&](std::string song_name, saucer::executor<void> exec) {
          std::println("[INFO] Unliked song: {}", song_name);
          std::thread t{[song_name, exec = std::move(exec)]() {
               mm::unlike_song(song_name);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("shuffle", [&](std::vector<std::string> songs, saucer::executor< std::vector<std::string>> exec) {
          std::println("[INFO] Shuffled songs"); 
          std::thread t{[songs, exec = std::move(exec)]() {
               auto res = mm::shuffle_songs(songs);
               exec.resolve(res);
          }};
          t.detach();
     });
     
     webview->expose("next", [&](saucer::executor<std::string> exec) {
          std::thread t{[exec = std::move(exec)]() {
               auto res = sm::next_song();
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("is_finished", []() -> bool {
          return sm::is_finished();
     });

     webview->expose("prev", [&](saucer::executor<std::string> exec) {
          std::thread t{[exec = std::move(exec)]() {
               auto res = sm::prev_song();
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("delete_song", [&](std::string file_path, saucer::executor<void> exec) {
          std::println("[INFO] Deleted song: {}", file_path);
          std::thread t{[file_path, exec = std::move(exec)]() {
               sm::delete_song(file_path);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("seek", [&](float position, saucer::executor<void> exec) {
          std::thread t{[position, exec = std::move(exec)]() {
               sm::seek(position);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("add_to_playlist", [&](std::string playlist_name, std::string file_path, saucer::executor<bool> exec) {
          std::println("[INFO] Add {} to {}", file_path, playlist_name);
          std::thread t{[playlist_name, file_path, exec = std::move(exec)]() {
               auto res = mm::add_to_playlist(playlist_name, file_path);
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("remove_from_playlist", [&](std::string playlist_name, std::string file_path, saucer::executor<bool> exec) {
          std::println("[INFO] Delete {} from {}", file_path, playlist_name);
          std::thread t{[playlist_name, file_path, exec = std::move(exec)]() {
               auto res = mm::remove_from_playlist(playlist_name, file_path);
               exec.resolve(res);
          }};
          t.detach();
     });

     // the sidebar needs the names, and opening one needs its tracks
     webview->expose("get_playlists", [&](saucer::executor<std::vector<std::string>> exec) {
          std::thread t{[exec = std::move(exec)]() {
               exec.resolve(mm::get_playlists());
          }};
          t.detach();
     });

     webview->expose("get_playlist", [&](std::string playlist_name, saucer::executor<std::vector<std::string>> exec) {
          std::thread t{[playlist_name, exec = std::move(exec)]() {
               exec.resolve(mm::get_playlist(playlist_name));
          }};
          t.detach();
     });

     webview->expose("create_playlist", [&](std::string playlist_name, saucer::executor<bool> exec) {
          std::println("[INFO] Create playist: {}", playlist_name);
          std::thread t{[playlist_name, exec = std::move(exec)]() {
               auto res = mm::create_playlist(playlist_name);
               exec.resolve(res);
          }};
          t.detach();
     });
     
     webview->expose("delete_playlist", [&](std::string playlist_name, saucer::executor<bool> exec) {
          std::println("[INFO] Delete playist: {}", playlist_name);
          std::thread t{[playlist_name, exec = std::move(exec)]() {
               auto res = mm::delete_playlist(playlist_name);
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("rename_playlist", [&](std::string playlist_name, std::string new_playlist_name ,saucer::executor<bool> exec) {
          std::println("[INFO] Delete playist: {}", playlist_name);
          std::thread t{[playlist_name, new_playlist_name, exec = std::move(exec)]() {
               auto res = mm::rename_playlist(playlist_name, new_playlist_name);
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->set_url("http://localhost:5173/");
     window->set_min_size({1200, 920});
     window->set_maximized(true);
     window->set_decorations(saucer::window::decoration::none);
     window->show();

     co_await app->finish();

     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "yugen"})->run(start);
}
