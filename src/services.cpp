#include <algorithm>
#include <cstddef>
#include <fstream>
#include <print>
#include <random>
#include <string>
#include <vector>
#include <filesystem>
#include <unistd.h>
#include <pwd.h>
#include <nlohmann/json.hpp>

#include "miniaudio.h"
#include "taglib.h"
#include "taglib/mpegfile.h"
#include <taglib/id3v2tag.h>
#include "taglib/fileref.h"
#include "taglib/tag.h"
#include <taglib/attachedpictureframe.h>
#include "tfile.h"
#include "services.h"

namespace fs = std::filesystem;

using json = nlohmann::json;
namespace yugen 
{
     static ma_sound sound;
     static bool sound_initialized = false;
     static std::vector<std::string> play_queue;
     static int queue_index = -1;

     std::vector<std::string> fetch_songs(const std::string &file_path)
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
          if(sound_initialized)
          {
               ma_sound_stop(&sound);
               ma_sound_uninit(&sound);

               sound_initialized = false;
          }

          ma_result res = ma_sound_init_from_file(engine,file_path.c_str(), 0, NULL, NULL, &sound);
          std::println("[INFO] Sound init result: {}", (int)res);
          ma_sound_start(&sound);
          sound_initialized = true;
          std::println("[INFO] Playing: {}", file_path);
     }

     float get_pos()
     {
          float cursor = 0.0f;
          if(sound_initialized) ma_sound_get_cursor_in_seconds(&sound, &cursor);
          return cursor;
     }

     float get_len()
     {
          float len = 0.0f;
          if(sound_initialized) ma_sound_get_length_in_seconds(&sound, &len);
          return len;
     }

     void resume()
     {
          if(sound_initialized) ma_sound_start(&sound);
     }

     void stop()
     {
          if(sound_initialized) ma_sound_stop(&sound);
     }

     void toggle_loop()
     {
          if(sound_initialized)
          {
               ma_bool32 cur = ma_sound_is_looping(&sound);
               ma_sound_set_looping(&sound, !cur);
          }
     }

     std::vector<std::string> get_metadata(const std::string &file_path)
     {
          TagLib::FileRef f(file_path.c_str());
          if(!f.isNull() && f.tag())
          {
               std::vector<std::string> out_vec;
               TagLib::Tag *tag = f.tag();
               
               out_vec.emplace_back(tag->title().toCString(true));
               out_vec.emplace_back(tag->artist().toCString(true));
               out_vec.emplace_back(tag->album().toCString(true));

               return out_vec;
          }

          return {};
     }

     std::string get_cover(const std::string &file_path)
     {
          TagLib::MPEG::File f(file_path.c_str());
          auto* tag = f.ID3v2Tag();
          if(!tag) return "";

          auto frames = tag->frameListMap()["APIC"];
          if(frames.isEmpty()) return "";

          auto* pic = static_cast<TagLib::ID3v2::AttachedPictureFrame*>(frames.front());
          auto data = pic->picture();

          return base64_encode(reinterpret_cast<const unsigned char*>(data.data()), data.size());
     }

     std::string base64_encode(const unsigned char *data, size_t len)
     {
          static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          std::string result;

          for(std::size_t i = 0; i < len; i += 3)
          {
               unsigned int b = (data[i] << 16) | (i + 1 < len ? data[i + 1] << 8 : 0) | (i + 2 < len ? data[i + 2] : 0);
               result += chars[(b >> 18) & 0x3F];
               result += chars[(b >> 12) & 0x3F];

               result += (i + 1 < len) ? chars[(b >> 6) & 0x3F] : '=';
               result += (i + 2 < len) ? chars[b & 0x3F] : '=';
          }

          return result;
     }

     std::vector<std::string> search_youtube(const std::string& query, int count) 
     {
          std::string cmd = "yt-dlp \"ytsearch" + std::to_string(count) 
               + ":" + query + "\" --flat-playlist --no-warnings --skip-download --print title --print id";
          
               FILE* pipe = popen(cmd.c_str(), "r");
          if (!pipe) return {};
          
          std::vector<std::string> results;
          char buffer[512];
          while (fgets(buffer, sizeof(buffer), pipe)) 
          {
               std::string line(buffer);
               if (!line.empty() && line.back() == '\n') line.pop_back();
               results.push_back(line);
          }
          pclose(pipe);
          return results;
     }
     std::string download_youtube(const std::string& id, const std::string& output_path) 
     {
          std::string cmd = "yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o \"" 
               + output_path + "/%(title)s [%(id)s].%(ext)s\" \"https://youtube.com/watch?v=" + id + "\"";
          std::system(cmd.c_str());
          return "done";
     }

     std::string data_dir()
     {
          passwd* p = getpwuid(getuid());
          return p ? std::string(p->pw_dir) + "/.config/yugen" : "";
     }

     std::vector<std::string> get_liked_songs()
     {
          std::string path = data_dir() + "/liked_songs.json";
          if(!fs::exists(path)) return {};

          std::ifstream f(path);
          json data = json::parse(f);

          std::vector<std::string> liked_songs;

          for(const auto& song : data) liked_songs.push_back(song);

          return liked_songs;
     }

     void like_song(const std::string &name)
     {
          std::string path = data_dir() + "/liked_songs.json";

          json data = json::array();
          if(fs::exists(path)) 
          { 
               std::ifstream f(path);
               data = json::parse(f);
          }

          data.push_back(name);

          std::ofstream out(path);
          out << data.dump();
     }

     void unlike_song(const std::string &name)
     {
          std::string path = data_dir() + "/liked_songs.json";

          json data = json::array();
          if(fs::exists(path)) 
          {
               std::ifstream f(path);
               data = json::parse(f);
          }

          data.erase(std::remove(data.begin(), data.end(),name), data.end());

          std::ofstream out(path);
          out << data.dump();
     }
     std::vector<std::string> shuffle_songs(const std::vector<std::string>& songs)
     {
          play_queue = songs;
          std::random_device rd;
          std::mt19937 g(rd());
          std::shuffle(play_queue.begin(), play_queue.end(), g);
          queue_index = 0;
          return play_queue;
     }
     
     std::string next_song()
     {
          if(play_queue.empty()) return "";
          queue_index = (queue_index + 1) % play_queue.size();
          return play_queue[queue_index];
     }

     std::string prev_song()
     {
          if(play_queue.empty()) return "";
          queue_index = (queue_index - 1) % play_queue.size();
          return play_queue[queue_index];
     }

     bool is_finished() 
     {
          if (!sound_initialized) return false;
          return ma_sound_at_end(&sound);
     }

     void delete_song(const std::string& file_path)
     {
          if(!fs::exists(file_path)) return;
          fs::remove(file_path);
     }

     void seek(float position)
     {
          if(!sound_initialized) return;

          ma_sound_seek_to_pcm_frame(&sound, 0);
          float sample_rate = ma_engine_get_sample_rate(sound.engineNode.pEngine);
          ma_uint64 frame = (ma_uint64)(position * sample_rate);
          ma_sound_seek_to_pcm_frame(&sound, frame);
     }
}
