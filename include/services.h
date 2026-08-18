#pragma once

#include <cstring>
#include <string>
#include <vector>
#include <random>
#include <nlohmann/json.hpp>

#include "miniaudio.h"

using json = nlohmann::json;

namespace yugen
{
     std::string data_dir();
     struct TrackInfo
     {
          std::string title;
          std::string artist;
          std::string album;
     };

     class Core 
     {
          public:
               static std::string download_from_yt(const std::string& id, const std::string& output_path);
               static std::string base64_encode(const unsigned char* data, size_t len);
               static std::string get_cover(const std::string& file_path);

               static std::vector<std::string> search_youtube(const std::string& query, int count);

          private:
               //Nothing here
     };
     class SoundManager 
     {
          public:
               static std::vector<std::string> fetch_songs(const std::string& file_path);
               static std::vector<std::string> get_metadata(const std::string& file_path);

               static std::string next_song();
               static std::string prev_song();

               static void play(ma_engine *engine, const std::string& file_path);
               static float get_pos();
               static float get_len();
               static void stop();
               static void resume();
               static void toggle_loop();
               static void seek(float position); 
               static void delete_song(const std::string& file_path);
               static bool is_finished();

          private:
               //Nothing here
     };

     class MusicManager 
     {
          public:
               static std::vector<std::string> shuffle_songs(const std::vector<std::string>& songs);
               static std::vector<std::string> get_playlist(const std::string& playlist_name);
               static std::vector<std::string> get_playlists();
               static std::vector<std::string> get_liked_songs();
               
               static bool rename_playlist(const std::string& playlist_name, const std::string& new_playlist_name);
               static bool remove_from_playlist(const std::string& playlist_name, const std::string& file_path);
               static bool add_to_playlist(const std::string& playlist_name, const std::string& file_path);
               static bool delete_playlist(const std::string& playlist_name);
               static bool create_playlist(const std::string& playlist_name);
               
               static void unlike_song(const std::string& name);
               static void like_song(const std::string& name);
          
               private:
                    static bool save_playlists(const json& data);
                    static json load_playlists();
                    
     };
}
