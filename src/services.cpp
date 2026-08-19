// standard library
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <print>
#include <random>
#include <string>
#include <thread>
#include <vector>

// posix
#include <pwd.h>
#include <unistd.h>

// third party
#include <curl/curl.h>
#include <discordpp.h>
#include <nlohmann/json.hpp>
#include <taglib/attachedpictureframe.h>
#include <taglib/audioproperties.h>
#include <taglib/fileref.h>
#include <taglib/id3v2tag.h>
#include <taglib/mpegfile.h>
#include <taglib/tag.h>
#include <taglib/taglib.h>
#include <taglib/tfile.h>

// project
#include "miniaudio.h"
#include "services.h"

namespace fs = std::filesystem;

namespace yugen
{
     namespace
     {
          constexpr const char* PLAYLISTS_FILE = "/playlists.json";
          constexpr const char* LIKED_SONGS_FILE = "/liked_songs.json";

          // how long the presence thread sleeps between callback pumps; the
          // discord sdk needs RunCallbacks called regularly, and a track
          // change wakes the thread early through the condition variable
          constexpr auto DISCORD_POLL_INTERVAL = std::chrono::milliseconds(100);

          // one voice at a time: starting a track tears the previous one down
          ma_sound sound;
          bool sound_initialized = false;

          // what next/prev walk over, filled in by shuffle_songs
          std::vector<std::string> play_queue;
          int queue_index = -1;
     }

     // Where everything the player owns is kept. Read out of the passwd entry
     // rather than $HOME so it stays right when the process is started by
     // something that does not set the environment, like a .desktop launcher.
     std::string data_dir()
     {
          passwd* p = getpwuid(getuid());
          return p ? std::string(p->pw_dir) + "/.config/yugen" : "";
     }

     /*
      * Core - yt-dlp, curl, and the artwork carried in the files themselves.
      */
     std::string Core::shell_quote(const std::string& arg)
     {
          // single quotes disable every expansion the shell does, so the only
          // character left to handle is the quote itself
          std::string out = "'";

          for(char c : arg)
          {
               if(c == '\'') out += "'\\''";
               else out += c;
          }

          out += "'";

          return out;
     }

     // Runs a command and hands back its stdout split into lines. yt-dlp prints
     // one field per line with --print, so a line here is a field, not a result.
     std::vector<std::string> Core::run_command_lines(const std::string& cmd)
     {
          FILE* pipe = popen(cmd.c_str(), "r");
          if(!pipe) return {};

          std::vector<std::string> results;
          std::array<char, 512> buffer;

          while(fgets(buffer.data(), buffer.size(), pipe))
          {
               std::string line(buffer.data());
               if(!line.empty() && line.back() == '\n') line.pop_back();
               results.push_back(std::move(line));
          }

          pclose(pipe);

          return results;
     }

     // Two lines per hit, in --print order: title, id. --flat-playlist keeps
     // yt-dlp from opening each video, which is what makes the search fast.
     std::vector<std::string> Core::search_youtube(const std::string& query, int count)
     {
          const std::string target = "ytsearch" + std::to_string(count) + ":" + query;

          return run_command_lines("yt-dlp " + shell_quote(target) +
               " --flat-playlist --no-warnings --skip-download --print title --print id");
     }

     // Three lines per hit: title, page url, thumbnail url. Soundcloud has no id
     // to rebuild a url from the way youtube does, so the url is carried along.
     std::vector<std::string> Core::search_sound_cloud(const std::string& query, int count)
     {
          const std::string target = "scsearch" + std::to_string(count) + ":" + query;

          return run_command_lines("yt-dlp " + shell_quote(target) +
               " --flat-playlist --no-warnings --skip-download --print title --print webpage_url"
               " --print '%(thumbnails.0.url)s'");
     }

     // Shared body of the two download calls: extract the audio, transcode to mp3
     // and let yt-dlp write the cover and the tags into the file, so the library
     // can read them back later without a second lookup. Blocks until it is done.
     std::string Core::download_with_ytdlp(const std::string& target, const std::string& output_path)
     {
          const std::string cmd = "yt-dlp -x --audio-format mp3 --embed-thumbnail --embed-metadata -o " +
               shell_quote(output_path + "/%(title)s [%(id)s].%(ext)s") + " " + shell_quote(target);

          const int status = std::system(cmd.c_str());

          if(status != 0)
          {
               std::println("[ERROR] yt-dlp exited with {} for {}", status, target);
               return "";
          }

          return "done";
     }

     std::string Core::download_from_yt(const std::string& id, const std::string& output_path)
     {
          return download_with_ytdlp("https://youtube.com/watch?v=" + id, output_path);
     }

     std::string Core::download_from_sc(const std::string& url, const std::string& output_path)
     {
          return download_with_ytdlp(url, output_path);
     }

     // curl hands the body over in chunks; each one is appended to the string it
     // was given through CURLOPT_WRITEDATA. Returning less than it was handed
     // tells curl to abort the transfer, so the full count always comes back.
     std::size_t Core::write_callback(void* contents, std::size_t size, std::size_t nmemb, std::string* output)
     {
          const std::size_t bytes = size * nmemb;
          output->append(reinterpret_cast<const char*>(contents), bytes);

          return bytes;
     }

     // Blocking GET, whole body in a string. Returns an empty string on any
     // failure - the callers have nothing useful to do with the reason.
     std::string Core::fetch_url(const std::string& url)
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

     // Asks lrclib for every sheet matching the track and picks one out of the
     // results. The title and artist go through curl's escaping first, since a
     // track name is free text and lands straight in a query string.
     std::string Core::get_lyrics(const std::string& title, const std::string& artist)
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

          const std::string response = fetch_url(url);
          if(response.empty()) return "";

          const auto data = json::parse(response, nullptr, false);
          if(data.is_discarded() || data.empty()) return "";

          // the search returns every match and only some of them carry timings, so
          // a timed sheet anywhere in the list beats the closest name match
          for(const auto& hit : data)
          {
               if(hit.contains("syncedLyrics") && !hit["syncedLyrics"].is_null())
               {
                    return hit["syncedLyrics"].get<std::string>();
               }
          }

          // nothing is timed: fall back in the order the search ranked them
          for(const auto& hit : data)
          {
               if(hit.contains("plainLyrics") && !hit["plainLyrics"].is_null())
               {
                    return hit["plainLyrics"].get<std::string>();
               }
          }

          return "";
     }

     // Reads the embedded cover out of the mp3's ID3v2 APIC frame and returns it
     // base64 encoded, so the ui can drop it into an <img> src without a file on
     // disk to serve. Empty string when the file carries no artwork.
     std::string Core::get_cover(const std::string& file_path)
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

     // Plain base64: three bytes in, four characters out, the tail padded with =.
     std::string Core::base64_encode(const unsigned char* data, std::size_t len)
     {
          static const char* chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          std::string result;
          result.reserve(((len + 2) / 3) * 4); // exact size, so no reallocation while encoding

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

     /*
      * SoundManager - the single voice, the queue, and the tags on disk.
      */
     // Starts a track: the previous sound is stopped and freed first, so only one
     // is ever alive. The tags are passed in from the ui rather than read off the
     // file again here, since it already has them from get_metadata.
     void SoundManager::play(ma_engine* engine, const std::string& file_path,
                    const std::string& title, const std::string& artist, const std::string& album)
     {
          if(sound_initialized)
          {
               ma_sound_stop(&sound);
               ma_sound_uninit(&sound);

               sound_initialized = false;
          }

          const ma_result res = ma_sound_init_from_file(engine, file_path.c_str(), 0, NULL, NULL, &sound);

          if(res != MA_SUCCESS)
          {
               // `sound` is left untouched by a failed init, so nothing to tear down
               std::println("[ERROR] Sound init failed ({}): {}", static_cast<int>(res), file_path);
               return;
          }

          ma_sound_start(&sound);
          sound_initialized = true;

          std::println("[INFO] Playing: {}", file_path);

          // the track is recorded even when sharing is off, so that switching it
          // back on can publish whatever is playing at that moment instead of
          // waiting for the next track; whether it reaches discord is the
          // presence thread's call
          {
               std::lock_guard<std::mutex> lk(g_discord_state.mtx);

               g_discord_state.current_track = {.title = title, .artist = artist, .album = album};
               g_discord_state.dirty = true;
          }

          g_discord_state.cv.notify_one();
     }

     void SoundManager::resume()
     {
          if(sound_initialized) ma_sound_start(&sound);
     }

     void SoundManager::stop()
     {
          if(sound_initialized) ma_sound_stop(&sound);
     }

     // miniaudio counts in pcm frames, the ui thinks in seconds, so the position
     // is scaled by the engine's sample rate on the way in.
     void SoundManager::seek(float position)
     {
          if(!sound_initialized) return;

          const float sample_rate = ma_engine_get_sample_rate(sound.engineNode.pEngine);
          const ma_uint64 frame = static_cast<ma_uint64>(position * sample_rate);

          ma_sound_seek_to_pcm_frame(&sound, frame);
     }

     void SoundManager::toggle_loop()
     {
          if(!sound_initialized) return;

          const ma_bool32 cur = ma_sound_is_looping(&sound);
          ma_sound_set_looping(&sound, !cur);
     }

     std::string SoundManager::next_song()
     {
          if(play_queue.empty()) return "";

          const int size = static_cast<int>(play_queue.size());
          queue_index = (queue_index + 1) % size;

          return play_queue[queue_index];
     }

     std::string SoundManager::prev_song()
     {
          if(play_queue.empty()) return "";

          // C++ keeps the sign on a negative modulo, so wrapping past the first
          // track has to add the size back before taking the remainder
          const int size = static_cast<int>(play_queue.size());
          queue_index = ((queue_index - 1) % size + size) % size;

          return play_queue[queue_index];
     }

     // True once a track has been loaded, and it stays true while paused - what
     // it really answers is whether there is a current track at all.
     bool SoundManager::is_playing()
     {
          return sound_initialized;
     }

     // Polled by the ui to decide when to move on to the next track.
     bool SoundManager::is_finished()
     {
          if(!sound_initialized) return false;

          return ma_sound_at_end(&sound);
     }

     float SoundManager::get_pos()
     {
          float cursor = 0.0f;
          if(sound_initialized) ma_sound_get_cursor_in_seconds(&sound, &cursor);

          return cursor;
     }

     float SoundManager::get_len()
     {
          float len = 0.0f;
          if(sound_initialized) ma_sound_get_length_in_seconds(&sound, &len);

          return len;
     }

     // Every mp3 directly inside the folder, file names only - the ui already
     // knows the folder it asked about. Not recursive.
     std::vector<std::string> SoundManager::fetch_songs(const std::string& file_path)
     {
          if(!fs::exists(file_path)) return {};

          std::vector<std::string> out_vec;

          for(const auto& entry : fs::directory_iterator(file_path))
          {
               if(entry.path().extension() == ".mp3") out_vec.push_back(entry.path().filename().string());
          }

          return out_vec;
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

     // Title, artist, album, length in seconds and the added timestamp, in that
     // order - the ui unpacks it positionally. Empty when the file has no tags.
     std::vector<std::string> SoundManager::get_metadata(const std::string& file_path)
     {
          TagLib::FileRef f(file_path.c_str());
          if(f.isNull() || !f.tag()) return {};

          TagLib::Tag* tag = f.tag();

          std::vector<std::string> out_vec;
          out_vec.reserve(5);

          out_vec.emplace_back(tag->title().toCString(true));
          out_vec.emplace_back(tag->artist().toCString(true));
          out_vec.emplace_back(tag->album().toCString(true));

          // seconds, read from the header so the file does not have to be played
          const int seconds = f.audioProperties() ? f.audioProperties()->lengthInSeconds() : 0;
          out_vec.emplace_back(std::to_string(seconds));

          // unix seconds, what "recently added" sorts on
          out_vec.emplace_back(std::to_string(added_time(file_path)));

          return out_vec;
     }

     void SoundManager::delete_song(const std::string& file_path)
     {
          if(!fs::exists(file_path)) return;

          fs::remove(file_path);
     }

     /*
      * MusicManager - playlists.json and liked_songs.json.
      */
     // The whole playlists file, or an empty object if it is missing or unreadable,
     // so a first run behaves like an empty library instead of an error.
     json MusicManager::load_playlists()
     {
          const std::string path = data_dir() + PLAYLISTS_FILE;

          if(!fs::exists(path)) return json::object();

          std::ifstream f(path);
          if(!f.is_open()) return json::object();

          return json::parse(f);
     }

     // Writes the object back out indented, so the file stays hand-editable.
     bool MusicManager::save_playlists(const json& data)
     {
          const std::string path = data_dir() + PLAYLISTS_FILE;

          std::ofstream out(path);
          if(!out.is_open()) return false;

          try
          {
               out << data.dump(4);
               return true;
          }
          catch(const fs::filesystem_error&)
          {
               return false;
          }
     }

     std::vector<std::string> MusicManager::get_playlists()
     {
          const json data = load_playlists();

          std::vector<std::string> names;
          names.reserve(data.size());

          for(const auto& [name, tracks] : data.items()) names.push_back(name);

          return names;
     }

     std::vector<std::string> MusicManager::get_playlist(const std::string& playlist_name)
     {
          const json data = load_playlists();

          if(!data.contains(playlist_name)) return {};

          return data.at(playlist_name).get<std::vector<std::string>>();
     }

     bool MusicManager::create_playlist(const std::string& playlist_name)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name))
          {
               data[playlist_name] = json::array();
          }

          return save_playlists(data);
     }

     bool MusicManager::delete_playlist(const std::string& playlist_name)
     {
          json data = load_playlists();

          if(data.contains(playlist_name))
          {
               data.erase(playlist_name);
          }

          return save_playlists(data);
     }

     bool MusicManager::rename_playlist(const std::string& playlist_name, const std::string& new_playlist_name)
     {
          json data = load_playlists();

          if(data.contains(playlist_name) && !data.contains(new_playlist_name))
          {
               data[new_playlist_name] = data[playlist_name];
               data.erase(playlist_name);
          }

          return save_playlists(data);
     }

     bool MusicManager::add_to_playlist(const std::string& playlist_name, const std::string& file_path)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) return false;

          auto& playlist = data.at(playlist_name);

          if(std::find(playlist.begin(), playlist.end(), file_path) != playlist.end()) return false;

          playlist.push_back(file_path);

          return save_playlists(data);
     }

     bool MusicManager::remove_from_playlist(const std::string& playlist_name, const std::string& file_path)
     {
          json data = load_playlists();

          if(!data.contains(playlist_name)) return false;

          auto& playlist = data.at(playlist_name);
          auto it = std::find(playlist.begin(), playlist.end(), file_path);

          if(it == playlist.end()) return false;

          playlist.erase(it);

          return save_playlists(data);
     }

     std::vector<std::string> MusicManager::get_liked_songs()
     {
          const std::string path = data_dir() + LIKED_SONGS_FILE;
          if(!fs::exists(path)) return {};

          std::ifstream f(path);
          const json data = json::parse(f);

          std::vector<std::string> liked_songs;
          liked_songs.reserve(data.size());

          for(const auto& song : data) liked_songs.push_back(song);

          return liked_songs;
     }

     void MusicManager::like_song(const std::string& name)
     {
          const std::string path = data_dir() + LIKED_SONGS_FILE;

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

     void MusicManager::unlike_song(const std::string& name)
     {
          const std::string path = data_dir() + LIKED_SONGS_FILE;

          json data = json::array();

          if(fs::exists(path))
          {
               std::ifstream f(path);
               data = json::parse(f);
          }

          data.erase(std::remove(data.begin(), data.end(), name), data.end());

          std::ofstream out(path);
          out << data.dump(4);
     }

     // Shuffles the given songs and arms them as the queue next/prev walk over,
     // then returns the new order so the ui can show it in the same sequence.
     std::vector<std::string> MusicManager::shuffle_songs(const std::vector<std::string>& songs)
     {
          play_queue = songs;

          std::random_device rd;
          std::mt19937 g(rd());
          std::shuffle(play_queue.begin(), play_queue.end(), g);

          queue_index = 0;

          return play_queue;
     }

     /*
      * Discord rich presence.
      */
     // Connects to the local discord client and leaves a thread behind that waits
     // for track changes and keeps the sdk's callbacks pumped. Everything from
     // here on runs on that thread until stop_discord() joins it.
     void start_discord(std::uint64_t app_id)
     {
          g_discord_state.running = true;

          g_discord_thread = std::thread([app_id]()
          {
               auto client = std::make_shared<discordpp::Client>();

               client->AddLogCallback([](std::string msg, discordpp::LoggingSeverity)
               {
                    std::println("[Discord] {}", msg);
               }, discordpp::LoggingSeverity::Warning);

               client->SetStatusChangedCallback([](discordpp::Client::Status status,
                    discordpp::Client::Error, std::uint32_t)
               {
                    std::println("[Discord] Status: {}", discordpp::Client::StatusToString(status));
               });

               client->Connect();

               while(g_discord_state.running.load())
               {
                    bool has_new_track = false;
                    TrackInfo track;

                    {
                         std::unique_lock<std::mutex> lk(g_discord_state.mtx);

                         // sleeping on the track change instead of spinning keeps
                         // this thread off the cpu, and the timeout is what still
                         // pumps the sdk callbacks while nothing is happening
                         g_discord_state.cv.wait_for(lk, DISCORD_POLL_INTERVAL, []
                         {
                              return g_discord_state.dirty || !g_discord_state.running.load();
                         });

                         if(g_discord_state.dirty)
                         {
                              track = g_discord_state.current_track;
                              g_discord_state.dirty = false;
                              has_new_track = true;
                         }
                    }

                    if(has_new_track)
                    {
                         // the flag is read here rather than at the call site, so
                         // flipping the switch is enough to clear a presence that
                         // is already up or to publish the running track
                         if(share_activity_on_dc && SoundManager::is_playing())
                         {
                              discordpp::Activity act;

                              act.SetType(discordpp::ActivityTypes::Listening);
                              act.SetDetails(track.title);
                              act.SetState(track.artist);

                              client->UpdateRichPresence(act, [](discordpp::ClientResult res)
                              {
                                   if(!res.Successful()) std::println("[Discord] Activity update failed");
                              });
                         }
                         else
                         {
                              client->ClearRichPresence();
                         }
                    }

                    // the sdk hands its results back from here, so it has to run
                    // on every pass and not once after the loop is over
                    discordpp::RunCallbacks();
               }

               client->Disconnect();
               discordpp::RunCallbacks();
          });
     }

     void stop_discord()
     {
          g_discord_state.running = false;
          g_discord_state.cv.notify_all();

          if(g_discord_thread.joinable()) g_discord_thread.join();
     }

     // Takes effect immediately: the flag is flipped and the presence thread is
     // woken with the current track marked as new, so turning it off clears the
     // activity that is showing and turning it on publishes what is playing.
     void set_activity(bool act)
     {
          share_activity_on_dc = act;

          {
               std::lock_guard<std::mutex> lk(g_discord_state.mtx);
               g_discord_state.dirty = true;
          }

          g_discord_state.cv.notify_one();
     }

     // Read by the ui on startup, so the switch comes up matching the real state.
     bool get_activity()
     {
          return share_activity_on_dc;
     }
}
