#include <algorithm>
#include <chrono>
#include <cmath>
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
#include <curl/curl.h>

#include "miniaudio.h"
#include "taglib.h"
#include "taglib/mpegfile.h"
#include <taglib/id3v2tag.h>
#include "taglib/fileref.h"
#include <taglib/audioproperties.h>
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
     
     std::string data_dir()
     {
          passwd* p = getpwuid(getuid());
          return p ? std::string(p->pw_dir) + "/.config/yugen" : "";
     }
     
     json MusicManager::load_playlists()
     {
          std::string path = data_dir() + "/playlists.json";

          if(!fs::exists(path)) return json::object();

          std::ifstream f(path);

          if(!f.is_open()) return json::object();

          return json::parse(f);
     }

     bool MusicManager::remove_from_playlist(const std::string &playlist_name, const std::string &file_path)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) return false;

          auto& playlist = data.at(playlist_name);
          auto it = std::find(playlist.begin(), playlist.end(), file_path);

          if(it == playlist.end()) return false;

          playlist.erase(it);

          return save_playlists(data);
     }

     bool MusicManager::add_to_playlist(const std::string &playlist_name, const std::string &file_path)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) return false;

          auto& playlist = data.at(playlist_name);

          if(std::find(playlist.begin(), playlist.end(), file_path) != playlist.end()) return false;

          playlist.push_back(file_path);

          return save_playlists(data);
     }
     
     void MusicManager::like_song(const std::string &name)
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
          out << data.dump(4);
     }

     void MusicManager::unlike_song(const std::string &name)
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
          out << data.dump(4);
     }
     
     bool MusicManager::save_playlists(const json &data)
     {
          std::string path = data_dir() + "/playlists.json";
          std::ofstream out(path);
          if(!out.is_open()) return false;
          try {
               out << data.dump(4);
               return true;
          }
          catch (fs::filesystem_error& e) {
               return false;
          }     
     }

     bool MusicManager::create_playlist(const std::string &playlist_name)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) {
               data[playlist_name] = json::array();
          }

          return save_playlists(data);
     }

     bool MusicManager::delete_playlist(const std::string &playlist_name)
     {
          json data = load_playlists();

          if(data.contains(playlist_name)) {
               data.erase(playlist_name);
          }

          return save_playlists(data);
     }

     bool MusicManager::rename_playlist(const std::string& playlist_name, const std::string& new_playlist_name)
     {
          json data = load_playlists();
          if(data.contains(playlist_name) && !data.contains(new_playlist_name)) {
               data[new_playlist_name] = data[playlist_name];
               data.erase(playlist_name);
          }

          return save_playlists(data);
     }
     
     std::vector<std::string> MusicManager::get_liked_songs()
     {
          std::string path = data_dir() + "/liked_songs.json";
          if(!fs::exists(path)) return {};

          std::ifstream f(path);
          json data = json::parse(f);

          std::vector<std::string> liked_songs;

          for(const auto& song : data) liked_songs.push_back(song);

          return liked_songs;
     }

     std::vector<std::string> MusicManager::shuffle_songs(const std::vector<std::string>& songs)
     {
          play_queue = songs;
          std::random_device rd;
          std::mt19937 g(rd());
          std::shuffle(play_queue.begin(), play_queue.end(), g);
          queue_index = 0;
          return play_queue;
     }
     
     std::vector<std::string> MusicManager::get_playlist(const std::string &playlist_name)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) return {};

          return data.at(playlist_name).get<std::vector<std::string>>();

     }

     std::vector<std::string> MusicManager::get_playlists()
     {
          json data = load_playlists();

          std::vector<std::string> names;

          for(const auto& [name, tracks] : data.items()) names.push_back(name);

          return names;
     }
     
     void SoundManager::play(ma_engine* engine, const std::string &file_path)
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

     void SoundManager::resume() {
          if(sound_initialized) ma_sound_start(&sound);
     }

     void SoundManager::stop() {
          if(sound_initialized) ma_sound_stop(&sound);
     }

     void SoundManager::toggle_loop() {
          if(sound_initialized)
          {
               ma_bool32 cur = ma_sound_is_looping(&sound);
               ma_sound_set_looping(&sound, !cur);
          }
     }



     void SoundManager::delete_song(const std::string& file_path)
     {
          if(!fs::exists(file_path)) return;
          fs::remove(file_path);
     }

     void SoundManager::seek(float position)
     {
          if(!sound_initialized) return;

          ma_sound_seek_to_pcm_frame(&sound, 0);
          float sample_rate = ma_engine_get_sample_rate(sound.engineNode.pEngine);
          ma_uint64 frame = (ma_uint64)(position * sample_rate);
          ma_sound_seek_to_pcm_frame(&sound, frame);
     }

     float SoundManager::get_pos() {
          float cursor = 0.0f;
          if(sound_initialized) ma_sound_get_cursor_in_seconds(&sound, &cursor);
          return cursor;
     }

     float SoundManager::get_len() {
          float len = 0.0f;
          if(sound_initialized) ma_sound_get_length_in_seconds(&sound, &len);
          return len;
     }


     bool SoundManager::is_finished() 
     {
          if (!sound_initialized) return false;
          return ma_sound_at_end(&sound);
     }
     // the mp3 has no "added" tag, so the file's own mtime stands in for it
     static long added_time(const std::string& file_path)
     {
          std::error_code ec;
          auto stamp = fs::last_write_time(file_path, ec);

          if(ec) return 0;

          auto epoch = std::chrono::clock_cast<std::chrono::system_clock>(stamp);

          return std::chrono::duration_cast<std::chrono::seconds>(epoch.time_since_epoch()).count();
     }

     std::vector<std::string> SoundManager::get_metadata(const std::string &file_path)
     {
          TagLib::FileRef f(file_path.c_str());
          if(!f.isNull() && f.tag())
          {
               std::vector<std::string> out_vec;
               TagLib::Tag *tag = f.tag();
               
               out_vec.emplace_back(tag->title().toCString(true));
               out_vec.emplace_back(tag->artist().toCString(true));
               out_vec.emplace_back(tag->album().toCString(true));

               // seconds, read from the header so the file does not have to be played
               int seconds = f.audioProperties() ? f.audioProperties()->lengthInSeconds() : 0;
               out_vec.emplace_back(std::to_string(seconds));

               // unix seconds, what "recently added" sorts on
               out_vec.emplace_back(std::to_string(added_time(file_path)));

               return out_vec;
          }

          return {};
     }
     std::vector<std::string> SoundManager::fetch_songs(const std::string &file_path)
     {
          if(!fs::exists(file_path)) return {};

          std::vector<std::string> out_vec;
          for(const auto& a : fs::directory_iterator(file_path))
          {
               if(a.path().extension() == ".mp3") out_vec.push_back(a.path().filename().string());
          }

          return out_vec;
     }

     
     std::string SoundManager::next_song()
     {
          if(play_queue.empty()) return "";
          queue_index = (queue_index + 1) % play_queue.size();
          return play_queue[queue_index];
     }

     std::string SoundManager::prev_song()
     {
          if(play_queue.empty()) return "";
          queue_index = (queue_index - 1) % play_queue.size();
          return play_queue[queue_index];
     }
     
     std::vector<std::string> Core::search_youtube(const std::string& query, int count) 
     {
          std::string cmd = "yt-dlp \"ytsearch" + std::to_string(count) 
               + ":" + query + 
                    "\" --flat-playlist --no-warnings --skip-download --print title --print id";
          
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

     std::vector<std::string> Core::search_sound_cloud(const std::string& query, int count) 
     {
          std::string cmd = "yt-dlp \"scsearch" + std::to_string(count) + 
               ":" + query + 
                    "\" --flat-playlist --no-warnings --skip-download --print title --print webpage_url --print \"%(thumbnails.0.url)s\"";
          
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

     std::string Core::get_cover(const std::string &file_path)
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

     std::string Core::base64_encode(const unsigned char *data, size_t len)
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

     std::string Core::download_from_yt(const std::string& id, const std::string& output_path) 
     {
          std::string cmd = "yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o \"" 
               + output_path + "/%(title)s [%(id)s].%(ext)s\" \"https://youtube.com/watch?v=" + id + "\"";
          std::system(cmd.c_str());
          return "done";
     }

     std::string Core::download_from_sc(const std::string& url, const std::string& output_path) 
     {
          std::string cmd = "yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o \"" 
               + output_path + "/%(title)s [%(id)s].%(ext)s\" \"" + url + "\"";
          std::system(cmd.c_str());
          return "done";
     }

     std::size_t Core::write_callback(void* contents, std::size_t size, std::size_t nmemb, std::string* output)
     {
          output->append((char*)contents, size * nmemb);
          return size * nmemb;
     }

     std::string Core::fetch_url(const std::string &url)
     {
          CURL* curl = curl_easy_init();
          if(!curl) return "";

          std::string response;
          curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
          curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
          curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
          curl_easy_setopt(curl, CURLOPT_USERAGENT, "yugen/1.0");
          curl_easy_perform(curl);
          curl_easy_cleanup(curl);

          return response;
     }

     std::string Core::get_lyrics(const std::string &title, const std::string &artist)
     {
          CURL* curl = curl_easy_init();
          if(!curl) return "";
          char* enc_title = curl_easy_escape(curl, title.c_str(), 0);
          char* enc_artist = curl_easy_escape(curl, artist.c_str(), 0);

          std::string url = "https://lrclib.net/api/search?track_name=";

          if(enc_title) url += enc_title;
          url += "&artist_name=";
          if(enc_artist) url += enc_artist;

          curl_free(enc_title);
          curl_free(enc_artist);
          curl_easy_cleanup(curl);          
          
          std::string response = fetch_url(url);
          if(response.empty()) return "";

          auto data = json::parse(response, nullptr, false);
          if(data.is_discarded() || data.empty()) return "";

          auto& first = data[0];
          if(first.contains("syncedLyrics") && !first["syncedLyrics"].is_null()) {
               return first["syncedLyrics"].get<std::string>();
          }
          
          if(first.contains("plainLyrics") && !first["plainLyrics"].is_null()) {
               return first["plainLyrics"].get<std::string>();
          }

          return "";
     }
}
