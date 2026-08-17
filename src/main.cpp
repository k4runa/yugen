#define MINIAUDIO_IMPLEMENTATION

#include "coco/stray/stray.hpp"
#include "saucer/app.hpp"
#include "saucer/window.hpp"
#include "services.h"
#include "../include/miniaudio.h"

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

     webview->expose("fetch_covers", [&](const std::string& file_path) -> std::vector<std::string> {
          const auto res = yugen::fetch_covers(file_path); 
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
     
     webview->set_url("http://localhost:5173/");
     window->show();

     co_await app->finish();

     ma_engine_uninit(&engine);
}

int main()
{
     return saucer::application::create({.id = "hello-world"})->run(start);
}
