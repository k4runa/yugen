#pragma once

#include <cstring>
#include <string>
#include <vector>
#include <random>

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

     std::vector<std::string> get_liked_songs();
     void like_song(const std::string& name);
     void unlike_song(const std::string& name);

     std::string data_dir();
     std::vector<std::string> shuffle_songs(const std::vector<std::string>& songs);
     std::string next_song();
     std::string prev_song();
     bool is_finished();
     void delete_song(const std::string& file_path);
     void seek(float position);
}
