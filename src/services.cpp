// standard library
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <print>
#include <random>
#include <set>
#include <string>
#include <thread>
#include <vector>

// posix
#include <pwd.h>
#include <unistd.h>

// third party
#include <curl/curl.h>
#include <discord-rpc.hpp>
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
          constexpr const char* PLAYLISTS_FILE   = "/playlists.json";
          // the one grey star last.fm answers with for everything it has no
          // picture of, recognised by the hash in its url so that a suggestion
          // carrying nothing is handed over as carrying nothing
          constexpr const char* PLACEHOLDER      = "2a96cbd8b46e442fc41c2b86b821562f";
          // where the last.fm key is kept once it has been seen once, beside
          // everything else the player owns. plain text rather than json: it is
          // one line, and install.sh writes it too.
          constexpr const char* API_KEY_FILE     = "/lastfm_key"; 
          constexpr const char* PROFILE_FILE     = "/profile.json";
          constexpr const char* LIKED_SONGS_FILE = "/liked_songs.json";
          constexpr const char* COVERS_FILE      = "/covers.json";

          constexpr const int MIN_COUNT = 50;

          // what is shown when no cover is known: an asset uploaded to the
          // application on discord's developer portal, named by its key
          constexpr const char* DISCORD_LOGO_ASSET = "yugen";

          // the key as the environment had it at startup, which is only how it
          // arrives the first time - init() puts it on disk and api_key() is
          // what everything reads afterwards. getenv answers with nothing at all
          // when the variable was never set, and a std::string cannot be built
          // from that, so it is checked before it is used.
          const char* env = getenv("LASTFM_API_KEY");
          std::string API_KEY = env ? env : "";

          // the last track handed to publish_activity(), kept so that turning
          // sharing back on can put it up again right away
          std::mutex discord_mtx;
          TrackInfo discord_track;
          bool discord_running = false;
          // set from the ui through set_activity(), read whenever a status is
          // about to go up - atomic because those are two different threads
          std::atomic<bool> share_activity_on_dc = true;
          // follows the transport rather than the ui: playback being paused takes
          // the status down without touching what the user asked for, so resuming
          // puts it back up instead of coming back to a switch that turned itself off
          std::atomic<bool> share_activity_paused = false;

          // file name -> cover url, mirrored to covers.json. a miss is stored as
          // an empty string, so a track without artwork is looked up once and
          // never asked about again
          std::mutex cover_mtx;
          json cover_cache;
          bool cover_cache_loaded = false;

          // lookups already in flight, so two publishes of the same track do not
          // both go out to the network
          std::set<std::string> cover_inflight;

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
          // Ensure minimum results are fetched for frontend pagination.
          // yt-dlp returns only available results if fewer exist, no error handling needed.
          if(count < MIN_COUNT) count = MIN_COUNT;
          const std::string target = "ytsearch" + std::to_string(count) + ":" + query;

          return run_command_lines("yt-dlp " + shell_quote(target) +
               " --flat-playlist --no-warnings --skip-download --print title --print id");
     }

     // Three lines per hit: title, page url, thumbnail url. Soundcloud has no id
     // to rebuild a url from the way youtube does, so the url is carried along.
     std::vector<std::string> Core::search_sound_cloud(const std::string& query, int count)
     {
          if(count < MIN_COUNT) count = MIN_COUNT; 
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

     std::size_t Core::get_playlist_count()
     {
          return MusicManager::get_playlists().size() + 1; 
     }
     

     // Reads the embedded cover out of the mp3's ID3v2 APIC frame and returns it
     // base64 encoded, so the ui can drop it into an <img> src without a file on
     // disk to serve. Empty string when the file carries no artwork.
     // Discord cannot read the cover embedded in the file, only fetch a url, so
     // the artwork has to be found somewhere public. The itunes search endpoint
     // needs no key and answers with a 100x100 url, which resizes by rewriting
     // the size in the path.
     std::string Core::lookup_cover_url(const std::string& title, const std::string& artist)
     {
          if(title.empty()) return "";

          CURL* curl = curl_easy_init();
          if(!curl) return "";

          const std::string term = artist.empty() ? title : artist + " " + title;
          char* enc_term = curl_easy_escape(curl, term.c_str(), 0);

          std::string url = "https://itunes.apple.com/search?entity=song&limit=1&term=";
          if(enc_term) url += enc_term;

          curl_free(enc_term);
          curl_easy_cleanup(curl);

          const std::string response = fetch_url(url);
          if(response.empty()) return "";

          const auto data = json::parse(response, nullptr, false);
          if(data.is_discarded() || !data.contains("results") || data["results"].empty()) return "";

          const auto& hit = data["results"][0];
          if(!hit.contains("artworkUrl100") || !hit["artworkUrl100"].is_string()) return "";

          std::string artwork = hit["artworkUrl100"].get<std::string>();

          const auto size = artwork.find("100x100");
          if(size != std::string::npos) artwork.replace(size, 7, "512x512");

          return artwork;
     }

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
               unsigned int b = (data[i] << 16) 
               | (i + 1 < len ? data[i + 1] << 8 : 0) | (i + 2 < len ? data[i + 2] : 0);
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
               share_activity_paused = false;
               ma_sound_stop(&sound);
               ma_sound_uninit(&sound);

               sound_initialized = false;
          }

          const float last_vol = load_volume();
          std::println("[DEBUG] Loaded volume: {}", last_vol);

          const ma_result res = ma_sound_init_from_file(engine, file_path.c_str(), 0, NULL, NULL, &sound);

          if(res != MA_SUCCESS)
          {
               // `sound` is left untouched by a failed init, so nothing to tear down
               std::println("[ERROR] Sound init failed ({}): {}", static_cast<int>(res), file_path);
               return;
          }

          ma_sound_set_volume(&sound, last_vol);
          ma_sound_start(&sound);
          sound_initialized = true;

          std::println("[INFO] Playing: {}", file_path);

          TrackInfo track {.title = title, .artist = artist, .album = album, .file_path = file_path};

          // the caller normally passes the tags it already has, but not every
          // call site does, and the ui may not have read them yet - so an empty
          // title means going to the file for them rather than showing nothing
          if(track.title.empty())
          {
               const auto meta = get_metadata(file_path);
               if(meta.size() >= 3)
               {
                    track = {.title = meta[0], .artist = meta[1], .album = meta[2], .file_path = file_path};
               }
          }

          // untagged file: the name on disk is still better than a blank status
          if(track.title.empty()) track.title = fs::path(file_path).filename().string();

          // handed over even when sharing is off: publish_activity() records it
          // either way, so switching sharing back on can put up whatever is
          // playing at that moment instead of waiting for the next track
          publish_activity(track);
     }

     // Puts the remembered track up again without changing what is being shared.
     // set_activity() does the same copy, but it writes the sharing flag on the
     // way through, so it cannot stand in for this - the transport has to be able
     // to take the status down and bring it back while the ui switch stays put.
     //
     // The copy is taken under the lock and published outside it, since
     // publish_activity() takes discord_mtx itself.
     void republish_activity() 
     {
          TrackInfo track;
          {
               std::lock_guard<std::mutex> lk(discord_mtx);
               track = discord_track;
          }

          publish_activity(track);
     }

     // Pausing and resuming both republish: discord only knows what it was last
     // told, so a status left standing keeps counting up its progress bar as if
     // the track were still running.
     void SoundManager::resume()
     {
          if(sound_initialized) {
               share_activity_paused = false;
               ma_sound_start(&sound);

               // the timestamps are rebuilt from the current position, so the bar
               // picks up where it stopped rather than where the track began
               republish_activity();
          }
     }

     // The flag is set whether or not sharing is on, so that switching it on
     // while paused does not put up a track that is not playing.
     void SoundManager::stop()
     {
          if(sound_initialized) {
               share_activity_paused = true;
               ma_sound_stop(&sound);

               republish_activity();
          }
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

     void SoundManager::set_volume(float volume)
     {
          if(sound_initialized) ma_sound_set_volume(&sound, volume);

          std::ofstream out(data_dir() + "/vol.txt");
          out << volume;
     }

     float SoundManager::load_volume()
     {
          std::string path = data_dir() + "/vol.txt";
          if(fs::exists(path))
          {
               std::ifstream f(path);
               float vol;
               f >> vol;
               return vol;
          }

          return 1.0f;
     }

     /*
      * MusicManager - playlists.json and liked_songs.json.
      * The whole playlists file, or an empty object if it is missing or unreadable,
      * so a first run behaves like an empty library instead of an error
      */
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
     // Opens the rpc connection. The library starts a worker thread that keeps
     // trying until the discord client answers and reconnects on its own if it
     // is closed and reopened later, so this returns immediately and never fails
     // in a way yugen has to handle - with no discord running, nothing happens.
     void start_discord(std::uint64_t app_id)
     {
          auto& rpc = discord::RPCManager::get();

          rpc.setClientID(std::to_string(app_id))
             .onReady([](const discord::User& user)
             {
                  std::println("[Discord] Connected as {}", user.username);
             })
             .onDisconnected([](int code, std::string_view message)
             {
                  std::println("[Discord] Disconnected ({}): {}", code, message);
             })
             .onErrored([](int code, std::string_view message)
             {
                  std::println("[Discord] Error ({}): {}", code, message);
             });

          rpc.initialize();

          {
               std::lock_guard<std::mutex> lk(discord_mtx);
               discord_running = true;
          }
     }

     // Clears the status before closing, otherwise the last track would sit on
     // the profile until the discord client itself notices yugen is gone.
     void stop_discord()
     {
          {
               std::lock_guard<std::mutex> lk(discord_mtx);
               discord_running = false;
          }

          discord::RPCManager::get().shutdown();
     }

     // The cover cache lives next to the playlists and is read once per run.
     // Callers must hold cover_mtx.
     static void load_cover_cache()
     {
          if(cover_cache_loaded) return;

          cover_cache_loaded = true;
          cover_cache = json::object();

          const std::string path = data_dir() + COVERS_FILE;
          if(!fs::exists(path)) return;

          std::ifstream f(path);
          if(!f.is_open()) return;

          const auto data = json::parse(f, nullptr, false);
          if(!data.is_discarded() && data.is_object()) cover_cache = data;
     }

     // A url already known for this track, if any. The outer optional says whether
     // the track has been looked up at all, the string whether anything was found.
     static std::optional<std::string> cached_cover(const std::string& key)
     {
          std::lock_guard<std::mutex> lk(cover_mtx);

          load_cover_cache();

          if(!cover_cache.contains(key)) return std::nullopt;

          return cover_cache.at(key).get<std::string>();
     }

     static void store_cover(const std::string& key, const std::string& url)
     {
          std::lock_guard<std::mutex> lk(cover_mtx);

          load_cover_cache();
          cover_cache[key] = url;
          cover_inflight.erase(key);

          std::ofstream out(data_dir() + COVERS_FILE);
          if(out.is_open()) out << cover_cache.dump(4);
     }

     // Tracks downloaded from youtube carry their video id in the file name, put
     // there by the -o template, and youtube serves a thumbnail under that id. So
     // for those the cover costs nothing: no request, no cache entry.
     static std::string youtube_cover(const std::string& file_name)
     {
          const auto close = file_name.rfind(']');
          if(close == std::string::npos) return "";

          const auto open = file_name.rfind('[', close);
          if(open == std::string::npos) return "";

          const std::string id = file_name.substr(open + 1, close - open - 1);

          // youtube ids are eleven characters of url-safe base64; a soundcloud id
          // is a plain number, which is what keeps the two apart here
          if(id.size() != 11) return "";

          for(char c : id)
          {
               if(!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return "";
          }

          return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
     }

     // Asks itunes on a worker thread and republishes the status once the answer
     // is in, so the track goes up immediately and the artwork catches up. A track
     // that has moved on in the meantime is left alone.
     static void request_cover_async(const TrackInfo& track, const std::string& key)
     {
          {
               std::lock_guard<std::mutex> lk(cover_mtx);
               if(!cover_inflight.insert(key).second) return;
          }

          std::thread worker{[track, key]()
          {
               const std::string url = Core::lookup_cover_url(track.title, track.artist);
               store_cover(key, url);

               if(url.empty()) return;

               publish_activity(track);
          }};

          worker.detach();
     }

     // Builds the status and queues it; the library's worker thread does the
     // writing, so this returns without touching the socket.
     //
     // The track is remembered whatever the sharing flag says, because that is
     // what set_activity() puts up when it is switched back on. An empty title
     // means there is nothing to show - the status comes down instead.
     void publish_activity(const TrackInfo& track)
     {
          std::lock_guard<std::mutex> lk(discord_mtx);

          discord_track = track;

          if(!discord_running) return;

          auto& rpc = discord::RPCManager::get();

          if(share_activity_paused || !share_activity_on_dc || track.title.empty())
          {
               rpc.clearPresence();
               return;
          }

          // where the track sits right now, turned into the wall clock window it
          // occupies, which is what discord draws the progress bar from
          const auto now = std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();

          const std::int64_t started = now - static_cast<std::int64_t>(SoundManager::get_pos());
          const std::int64_t ends = started + static_cast<std::int64_t>(SoundManager::get_len());

          // the cover, if one is known by now; the logo stands in until then and
          // whenever the track turns out to have no artwork anywhere
          const std::string key = fs::path(track.file_path).filename().string();

          std::string image = youtube_cover(key);

          if(image.empty())
          {
               const auto known = cached_cover(key);

               if(known) image = *known;
               else if(!key.empty()) request_cover_async(track, key);
          }

          if(image.empty()) image = DISCORD_LOGO_ASSET;

          rpc.getPresence()
             .setActivityType(discord::ActivityType::Listening)
             // the status line reads "Listening to <details>" rather than
             // "Listening to yugen", which is the closest a third party app
             // gets to how the spotify integration looks
             .setStatusDisplayType(discord::StatusDisplayType::Details)
             .setDetails(track.title)
             .setState(track.artist)
             .setLargeImageKey(image)
             .setLargeImageText(track.album.empty() ? "yugen" : track.album)
             .setStartTimestamp(started)
             .setEndTimestamp(ends);

          rpc.refresh();
     }

     // Takes effect immediately: the flag is flipped and the remembered track is
     // republished, so turning it off takes the status down and turning it on
     // puts what is playing up without waiting for the next track.
     void set_activity(bool act)
     {
          share_activity_on_dc = act;

          TrackInfo track;
          {
               std::lock_guard<std::mutex> lk(discord_mtx);
               track = discord_track;
          }

          publish_activity(track);
     }

     // Read by the ui on startup, so the switch comes up matching the real state.
     bool get_activity()
     {
          return share_activity_on_dc;
     }

     std::vector<TrackInfo> Profile::get_favorite_songs()
     {
          const json data = load_profile();

          if(data.empty() || !data.contains("favorite_songs") || 
               data["favorite_songs"].empty()) return {};

          std::vector<TrackInfo> songs {};
          for(const auto& s : data["favorite_songs"])
          {
               TrackInfo t;
               t.title = s.value("title", "");
               t.artist = s.value("artist", "");
               t.album = s.value("album","");
               t.file_path = s.value("file_path","");

               songs.push_back(t);
          }

          return songs;
     }

     bool Profile::add_favorite_song(const TrackInfo& track)
     {
          json data = load_profile();
          auto& arr = data["favorite_songs"];
          bool found = false;
          for(auto it = arr.begin(); it != arr.end(); ++it)
          {
               if((*it).value("file_path","") == track.file_path) {
                    found = true;
                    break;
               }
          }

          if(!found)
          {
               json song;
               song["title"] = track.title;
               song["artist"] = track.artist;
               song["album"] = track.album;
               song["file_path"] = track.file_path;

               data["favorite_songs"].push_back(song);
          }

          return save_data(data);
     }

     std::string Profile::get_profile_picture()
     {
          const json data = load_profile();
          if(data.empty()) return "";

          return data.contains("profile_pic_path") ? data["profile_pic_path"] : "";
     }

     std::string Profile::get_username()
     {
          const json data = load_profile();
          if(data.empty()) return "";

          return data.contains("username") ? data["username"] : "";
     }

     std::string Profile::get_biography()
     {
          const json data = load_profile();
          if(data.empty()) return "";

          return data.contains("biography") ? data["biography"] : "";
     }

     bool Profile::save_data(const json& data)
     {
          const std::string path = data_dir() + PROFILE_FILE;

          std::ofstream out(path);

          if(!out.is_open()) return false;

          try 
          {
               out << data.dump(4);
               return true;
          } 
          catch (std::exception& e) 
          {
               return false;
          }
     }

     json Profile::load_profile()
     {
          const std::string path = data_dir() + PROFILE_FILE;
          if(!fs::exists(path)) return json::object();

          std::ifstream f(path);
          if(!f.is_open()) return json::object();

          try {
               return json::parse(f);
          } catch (json::exception& e) {
               return json::object();
          }
     }

     bool Profile::set_profile_picture(const std::string& base64_data)
     {
          json data = load_profile();
          data["profile_pic_path"] = base64_data;
          return save_data(data);
     }

     bool Profile::set_username(const std::string& username)
     {
          json data = load_profile();
          data["username"] = username;
          return save_data(data);
     }

     bool Profile::set_biography(const std::string& bio)
     {
          json data = load_profile();
          data["biography"] = bio;
          return save_data(data);
     }

     bool Profile::remove_from_favorites(const std::string& file_path)
     {
          json data = load_profile();
          if(data.empty() || !data.contains("favorite_songs")) return false;

          auto& arr = data["favorite_songs"];
          for(auto it = arr.begin(); it != arr.end(); ++it)
          {
               if((*it).value("file_path","") == file_path) {
                    arr.erase(it);
                    break;
               }
          }
          return save_data(data);
     }

     /*
      * The tracks last.fm puts next to one of ours, as json text - the ui reads
      * it, since the json library in here is not the one saucer serialises with.
      *
      * It answers about one track at a time because that is the shape of the
      * call behind it: the file is read for its tags first, so what goes out is
      * a title and an artist rather than a path. Both are free text landing in a
      * query string, so both go through curl's escaping. Anything missing - no
      * key, no file, nothing back, nothing parseable - is an empty answer rather
      * than an error, and the ui carries on around it.
      */
     std::string MusicManager::get_similar(const std::string& file_path, const int limit = 10)
     {
          if(file_path.empty()) return {};
          if(!fs::exists(file_path)) return {};
          
          std::string url = "https://ws.audioscrobbler.com/2.0/?method=track.getsimilar";

          if(api_key().empty()) {
               std::println("[WARNING] NO LASTFM API KEY FOUND.");
               return "";
          }

          std::vector<std::string> metadata = SoundManager::get_metadata(file_path);
          const std::string title = metadata.size() > 0 ? metadata[0] : "";
          const std::string artist = metadata.size() > 1 ? metadata[1] : "";

          CURL* curl = curl_easy_init();
          if(!curl) return {};

          if(!artist.empty()) 
          {
               char* enc = curl_easy_escape(curl, artist.c_str(), 0);
               url += "&artist=" + std::string(enc);
               curl_free(enc);
          }

          if(!title.empty())
          {
               char* enc = curl_easy_escape(curl, title.c_str(), 0);
               url += "&track=" + std::string(enc);
               curl_free(enc); 
          }

          url += "&api_key=" + api_key()
          + "&format=json&autocorrect=1" + "&limit=" + std::to_string(limit);

          curl_easy_cleanup(curl);

          const std::string response = Core::fetch_url(url);
          if(response.empty()) return {};


          // parsed without throwing: what comes back is whatever the far end
          // felt like sending, including an error object with no tracks in it
          const auto data = json::parse(response, nullptr, false);
          if(data.is_discarded() || data.empty()) return {};
          if(!data.contains("similartracks")) return {};
          
          json result = json::array();

          const auto& similar = data["similartracks"];
          if(!similar.contains("track") || !similar["track"].is_array()) return {};

          const auto& tracks = similar["track"];

          // each entry is rebuilt rather than passed along as it arrived: the ui
          // wants four fields and last.fm sends a page of them
          for(const auto& t : tracks)
          {
               std::string name = t.value("name","");
               std::string art;

               if(t.contains("artist")) art = t["artist"].value("name","");

               // the sizes come as a list, and the largest is the one worth
               // showing on a card
               std::string img;
               if(t.contains("image") && t["image"].is_array()) {
                    for(const auto& i : t["image"]) {
                         if(i.value("size", "") == "extralarge") {
                              img = i.value("#text", "");
                              break;
                         }
                    }
               }

               // the placeholder is not a picture, and the ui would rather go
               // and look for a real one than hang a grey star on the shelf
               if(img.find(PLACEHOLDER) != std::string::npos) {
                    img = "";
               }

               // a track with no name is nothing the ui could show or search for
               if(!name.empty()) 
               {
                    // closeness to the track we asked about, which is the
                    // order the suggestions are read in. last.fm sends it as a
                    // number in some answers and as text in others, so both are
                    // taken - and one it cannot answer for sorts last rather
                    // than costing the whole pass.
                    double score = 0.0;

                    if(t.contains("match")) 
                    {
                         const auto& m = t["match"];
                         if(m.is_number()) {
                              score = m.get<double>();
                         } else if(m.is_string()) {
                              score = std::strtod(m.get<std::string>().c_str(), nullptr);
                         }
                    }

                    result.push_back({
                         {"name", name},
                         {"artist", art},
                         {"image", img},
                         {"match", score}
                    });
               }
          }

          return result.dump();
     }

     /*
      * The picture for one track, as a url, asked for by name.
      *
      * get_similar hands back most of its suggestions with nothing to show -
      * the similar list carries the placeholder far more often than it carries
      * artwork - so this is the second look, and the ui spends it per card.
      * What comes back is the album's cover rather than the track's, which is
      * what last.fm keeps on a track page, and it is handed over as it arrived:
      * the placeholder is filtered on the ui side, where a card that ends up
      * with nothing is simply not shown.
      */
     std::string MusicManager::get_track_cover(const std::string& artist, const std::string& track_name)
     {
          if(api_key().empty()) {
               std::println("[WARNING] NO LASTFM API KEY FOUND.");
               return "";
          }

          std::string url = "https://ws.audioscrobbler.com/2.0/?method=track.getInfo";
          
          CURL* curl = curl_easy_init();
          if(!curl) return "";

          if(!artist.empty()) {
               char* enc = curl_easy_escape(curl, artist.c_str(), 0);
               url += "&artist=" + std::string(enc);
               curl_free(enc);
          }

          if(!track_name.empty()) {
               char* enc = curl_easy_escape(curl, track_name.c_str(), 0);
               url += "&track=" + std::string(enc);
               curl_free(enc);
          }

          url += "&api_key=" + api_key() + "&format=json";

          curl_easy_cleanup(curl);
          
          const std::string response = Core::fetch_url(url);

          if(response.empty()) return "";

          const auto data = json::parse(response, nullptr, false);
          if(data.is_discarded() || data.empty()) return {};

          // a track last.fm knows by name but has no release for has no
          // picture either: every step down to the image list has to be there
          if(!data.contains("track") || !data["track"].contains("album") 
          || !data["track"]["album"].contains("image")) return "";

          const auto& images = data["track"]["album"]["image"];
          if(images.empty()) return "";

          // the same list of sizes as above, and the same reason for the largest

          for(const auto& i : images) {
               if(i.value("size", "") == "extralarge") {
                    return i.value("#text", "");
               }
          }

          return "";
     }

     /*
      * Keeps the key across runs.
      *
      * An `export` only lives in the shell that ran it: the app started from a
      * launcher next time - or from any other terminal - would come up without
      * one. So the first run that does have it writes it down, and every run
      * after that reads the file instead. Called once at startup, after the
      * data directory exists: an ofstream cannot make the directory itself, and
      * this failing quietly would look exactly like a key that never worked.
      *
      * A key already on disk is left alone. Nothing here is worth stopping the
      * app over, so a filesystem that will not cooperate is reported and
      * stepped over - it costs suggestions, not the player.
      */
     void MusicManager::init()
     {
          const std::string path = data_dir() + API_KEY_FILE;
          try {
               if(!fs::exists(path)) {
                    if(!API_KEY.empty()) {
                         std::ofstream f(path);
                         if(!f.is_open()) return;
                         f << API_KEY;
                    }
               }
          } catch (const fs::filesystem_error& e) {
               std::println("[WARN] Filesystem error: {}", e.what());
          }
     }

     /*
      * The key, wherever it is. The environment wins, since it is the one that
      * can be changed without touching anything, and the file init() left is
      * the fallback.
      *
      * Read once and kept: these two calls go out on a thread each and the ui
      * fires four of them at a time, so a value everyone parses for themselves
      * is a race rather than a saving. A function-local static is initialised by
      * whichever thread arrives first while the rest wait, and it is const
      * afterwards - nobody writes to it again.
      *
      * >> stops at the first space, which is what trims the newline off a file
      * written by a shell.
      */
     const std::string& MusicManager::api_key()
     {
          static const std::string key = [] {
               const char* env = getenv("LASTFM_API_KEY");
               if(env && *env) return std::string(env);

               std::ifstream f(data_dir() + API_KEY_FILE);
               std::string k;
               if(f) f >> k;
               return k;
          }();

          return key;
     }
}
