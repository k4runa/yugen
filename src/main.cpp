#include "saucer/executor.hpp"
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#define MINIAUDIO_IMPLEMENTATION

#include "coco/stray/stray.hpp"
#include "saucer/app.hpp"
#include "saucer/window.hpp"
#include "services.h"
#include "miniaudio.h"

#include <saucer/smartview.hpp>
#include <string>
#include <print>


coco::stray start(saucer::application *app)
{
     auto window = saucer::window::create(app).value();
     auto webview = saucer::smartview::create({.window = window});

     ma_engine engine;

     ma_result res = ma_engine_init(NULL, &engine);
     if(res != MA_SUCCESS) {
          std::println("[ERROR]: Engine init failed: {}", (int)(res));
     }

     window->set_title("yugen");
     window->set_decorations(saucer::window::decoration::none);

     webview->expose("fetch_songs", [&](const std::string& file_path) -> std::vector<std::string> {
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

     webview->expose("toggle_loop", [](){
          yugen::toggle_loop();
     });
     webview->expose("get_metadata", [&](const std::string& file_path) -> std::vector<std::string> {
          return yugen::get_metadata(file_path);
     });

     webview->expose("get_cover", [&](const std::string& file_path) -> std::string {
          return yugen::get_cover(file_path);
     });

     webview->expose("search", [&](std::string query, int count, saucer::executor<std::vector<std::string>> exec) {
          std::thread t{[query, count, exec = std::move(exec)]() {
               auto results = yugen::search_youtube(query, count);
               exec.resolve(results);
          }};
          t.detach();
     });

     webview->expose("download", [&](std::string id,  std::string output_path, saucer::executor<std::string> exec) {
          std::thread t{[id, output_path, exec = std::move(exec)]() {
               auto results = yugen::download_youtube(id, output_path);
               exec.resolve(results);
          }};
          t.detach();
     });


     
     webview->set_url("http://localhost:5173/");
     window->show();

     co_await app->finish();

     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "hello-world"})->run(start);
}
