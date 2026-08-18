#pragma once

#include <cstring>
#include <string>
#include <vector>
#include "miniaudio.h"

namespace yugen
{

     struct TrackInfo
     {
          std::string title;
          std::string artist;
          std::string album;
     };

     std::vector<std::string> fetch_songs(const std::string& file_path);
     std::vector<std::string> get_metadata(const std::string& file_path);
     void play(ma_engine *engine, const std::string& file_path);
     float get_pos();
     float get_len();
     void stop();
     void resume();
     void toggle_loop();

     std::string get_cover(const std::string& file_path);
     std::string base64_encode(const unsigned char* data, size_t len);

     std::vector<std::string> search_youtube(const std::string& query, int count);
     std::string download_youtube(const std::string& id, const std::string& output_path);
}
