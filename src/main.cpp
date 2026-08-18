
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
     window->set_decorations(saucer::window::decoration::none);

     // the webkit menu can't be edited, so it is turned off and drawn in the ui instead
     webview->set_context_menu(false);

     webview->expose("fetch_songs", [&](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Fetching songs on {}", file_path);
          const auto res = yugen::fetch_songs(file_path); 
          return res;
     });
     
     webview->expose("play_music", [&](const std::string& file_path) {
          yugen::play(&engine, file_path);
     });

     webview->expose("get_position", []() -> float {
          return yugen::get_pos();
     });

     webview->expose("get_length", []() -> float {
          return yugen::get_len();
     });
     
     webview->expose("stop", []() {
          yugen::stop();
     });

     webview->expose("resume", []() {
          yugen::resume();
     });

     webview->expose("toggle_loop", [](bool state){
          std::println("[INFO]: Toggle loop: {}", state);
          yugen::toggle_loop();
     });
     webview->expose("get_metadata", [&](const std::string& file_path) -> std::vector<std::string> {
          std::println("[INFO] Get metadata: {}", file_path);
          return yugen::get_metadata(file_path);
     });

     webview->expose("get_cover", [&](const std::string& file_path) -> std::string {
          std::println("[INFO] Get cover: {}", file_path);
          return yugen::get_cover(file_path);
     });

     webview->expose("search", [&](std::string query, int count, saucer::executor<std::vector<std::string>> exec) {
          std::println("[INFO] Searching query: {}", query);
          std::thread t{[query, count, exec = std::move(exec)]() {
               auto results = yugen::search_youtube(query, count);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("download", [&](std::string id,  std::string output_path, saucer::executor<std::string> exec) {
          std::println("[INFO] Download: {}", id);
          std::thread t{[id, output_path, exec = std::move(exec)]() {
               auto results = yugen::download_youtube(id, output_path);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("get_liked_songs", [&](saucer::executor<std::vector<std::string>> exec) {
          std::println("[INFO] Fetching liked songs:");
          std::thread t{[exec = std::move(exec)]() {
               auto results = yugen::get_liked_songs();
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("like_song", [&](std::string song_name, saucer::executor<void> exec) {
          std::println("[INFO] Liked song: {}", song_name);
          std::thread t{[song_name, exec = std::move(exec)]() {
               yugen::like_song(song_name);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("unlike_song", [&](std::string song_name, saucer::executor<void> exec) {
          std::println("[INFO] Unliked song: {}", song_name);
          std::thread t{[song_name, exec = std::move(exec)]() {
               yugen::unlike_song(song_name);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("shuffle", [&](std::vector<std::string> songs, saucer::executor< std::vector<std::string>> exec) {
          std::println("[INFO] Shuffle songs"); 
          std::thread t{[songs, exec = std::move(exec)]() {
               auto res = yugen::shuffle_songs(songs);
               exec.resolve(res);
          }};
          t.detach();
     });
     
     webview->expose("next", [&](saucer::executor<std::string> exec) {
          std::thread t{[exec = std::move(exec)]() {
               auto res = yugen::next_song();
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("is_finished", []() -> bool {
          return yugen::is_finished();
     });

     webview->expose("prev", [&](saucer::executor<std::string> exec) {
          std::thread t{[exec = std::move(exec)]() {
               auto res = yugen::prev_song();
               exec.resolve(res);
          }};
          t.detach();
     });

     webview->expose("delete_song", [&](std::string file_path, saucer::executor<void> exec) {
          std::thread t{[file_path, exec = std::move(exec)]() {
               yugen::delete_song(file_path);
               exec.resolve();
          }};
          t.detach();
     });

     webview->expose("seek", [&](float position, saucer::executor<void> exec) {
          std::thread t{[position, exec = std::move(exec)]() {
               yugen::seek(position);
               exec.resolve();
          }};
          t.detach();
     });
     
     
     // decorations are off, so the window controls have to come from the ui
     webview->expose("window_close", [&]() {
          window->close();
     });

     webview->expose("window_minimize", [&]() {
          window->set_minimized(true);
     });

     webview->expose("window_zoom", [&]() {
          window->set_maximized(!window->maximized());
     });

     webview->expose("window_drag", [&]() {
          window->start_drag();
     });

     webview->set_url("http://localhost:5173/");
     window->set_maximized(true);
     window->set_min_size({1370, 915});
     window->show();

     co_await app->finish();

     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "yugen"})->run(start);
}
