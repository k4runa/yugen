#include "services.h"
#include <print>
#include <string>
#include <vector>
#include <filesystem>

#include "../include/miniaudio.h"

namespace fs = std::filesystem;

namespace yugen 
{
     static ma_sound sound;
     static bool sound_initalized = false;

     std::vector<std::string> fetch_covers(const std::string &file_path)
     {
          if(!fs::exists(file_path)) return {};

          std::vector<std::string> out_vec;
          for(const auto& a : fs::directory_iterator(file_path))
          {
               if(a.path().extension() == ".mp3") out_vec.push_back(a.path().filename().string());
          }

          return out_vec;
     }

     void play(ma_engine* engine, const std::string &file_path)
     {
          if(sound_initalized)
          {
               ma_sound_stop(&sound);
               ma_sound_uninit(&sound);

               sound_initalized = false;
          }

          ma_result res = ma_sound_init_from_file(engine,file_path.c_str(), 0, NULL, NULL, &sound);
          std::println("[INFO] Sound init result: {}", (int)res);
          ma_sound_start(&sound);
          sound_initalized = true;
          std::println("[INFO] Playing: {}", file_path);
     }

     float get_pos()
     {
          float cursor = 0.0f;
          if(sound_initalized) ma_sound_get_cursor_in_seconds(&sound, &cursor);
          return cursor;
     }

     float get_len()
     {
          float len = 0.0f;
          if(sound_initalized) ma_sound_get_length_in_seconds(&sound, &len);
          return len;
     }

     void resume()
     {
          if(sound_initalized) ma_sound_start(&sound);
     }

     void stop()
     {
          if(sound_initalized) ma_sound_stop(&sound);
     }

     void toggle_loop()
     {
          if(sound_initalized)
          {
               ma_bool32 cur = ma_sound_is_looping(&sound);
               ma_sound_set_looping(&sound, !cur);
          }
     }
}
