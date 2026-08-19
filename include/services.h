#pragma once

// standard library
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// third party
#include <discordpp.h>
#include <nlohmann/json.hpp>

// project
#include "miniaudio.h"

namespace yugen
{
     using json = nlohmann::json;

     // ~/.config/yugen - playlists.json and liked_songs.json live here
     std::string data_dir();

     /*
      * Discord rich presence. The playing track is written here by whichever
      * thread called play(), and the background thread started by start_discord()
      * picks it up and pushes it to the discord client.
      */
     // set from the ui through set_activity(), read by the presence thread when
     // it decides whether to publish - atomic because those are two threads
     inline std::atomic<bool> share_activity_on_dc = true;

     struct TrackInfo
     {
          std::string title;
          std::string artist;
          std::string album;
     };

     // handed from the audio thread to the presence thread; every field
     // except `running` is guarded by `mtx`
     struct DiscordState
     {
          std::mutex mtx;
          std::condition_variable cv;
          TrackInfo current_track;
          bool dirty = false; // is there a new track?
          std::atomic<bool> running {false};
     };

     inline DiscordState g_discord_state;
     inline std::thread  g_discord_thread;

     // start_discord() connects and leaves the presence thread running until
     // stop_discord() joins it; both are called once, from start()
     void start_discord(std::uint64_t app_id);
     void stop_discord();

     // whether the current track is shared as a discord activity; the thread
     // keeps running when this is off, it just publishes nothing. changing it
     // applies right away - see set_activity()
     void set_activity(bool act);
     bool get_activity();

     /*
      * Core is everything that leaves the process. Searching and downloading
      * shell out to yt-dlp and read its stdout back; lyrics come from lrclib
      * over curl; cover art is pulled out of the file's own ID3 tags.
      *
      * Every call here blocks for as long as the network or the child process
      * takes, so none of them belong on the ui thread.
      */
     class Core
     {
          public:
               // search: one line per printed field, in yt-dlp's --print order
               static std::vector<std::string> search_youtube(const std::string& query, int count);
               static std::vector<std::string> search_sound_cloud(const std::string& query, int count);

               // download: blocking, returns "done" or "" on failure
               static std::string download_from_yt(const std::string& id, const std::string& output_path);
               static std::string download_from_sc(const std::string& url, const std::string& output_path);

               // network
               static std::string get_lyrics(const std::string& title, const std::string& artist);
               static std::string fetch_url(const std::string& url);

               // artwork, returned base64 encoded so the ui can inline it
               static std::string get_cover(const std::string& file_path);
               static std::string base64_encode(const unsigned char* data, std::size_t len);

          private:
               // wraps an argument in single quotes so a title carrying " or
               // $(...) cannot break out of the command line
               static std::string shell_quote(const std::string& arg);

               // runs a command and collects its stdout, one entry per line
               static std::vector<std::string> run_command_lines(const std::string& cmd);

               // shared body of download_from_yt / download_from_sc
               static std::string download_with_ytdlp(const std::string& target, const std::string& output_path);

               static std::size_t write_callback(void* contents, std::size_t size,
                    std::size_t nmemb, std::string* output);
     };

     /*
      * SoundManager owns the one miniaudio voice the player has. Starting a
      * track tears the previous one down, so only a single sound is ever alive
      * and the transport calls (resume/stop/seek) always mean "the current one".
      *
      * It also holds the shuffled queue next_song()/prev_song() walk over, and
      * reads the id3 tags off the files for the ui.
      */     class SoundManager
     {
          public:
               // playback
               static void play(ma_engine* engine, const std::string& file_path,
                    const std::string& title = "", const std::string& artist = "", const std::string& album = "");
               static void resume();
               static void stop();
               static void seek(float position);
               static void toggle_loop();

               // queue
               static std::string next_song();
               static std::string prev_song();

               // state
               static bool is_playing();
               static bool is_finished();
               static float get_pos();
               static float get_len();

               // files
               static std::vector<std::string> fetch_songs(const std::string& file_path);
               static std::vector<std::string> get_metadata(const std::string& file_path);
               static void delete_song(const std::string& file_path);
     };

     /*
      * MusicManager is the on-disk library: playlists.json (a name -> array of
      * file names object) and liked_songs.json (a flat array), both under
      * data_dir(). Every call reads the whole file, edits the json in memory and
      * writes it back - the files are small enough that nothing is cached, which
      * keeps them correct if something else edits them between calls.
      */     class MusicManager
     {
          public:
               // playlists
               static std::vector<std::string> get_playlists();
               static std::vector<std::string> get_playlist(const std::string& playlist_name);
               static bool create_playlist(const std::string& playlist_name);
               static bool delete_playlist(const std::string& playlist_name);
               static bool rename_playlist(const std::string& playlist_name, const std::string& new_playlist_name);
               static bool add_to_playlist(const std::string& playlist_name, const std::string& file_path);
               static bool remove_from_playlist(const std::string& playlist_name, const std::string& file_path);

               // liked songs
               static std::vector<std::string> get_liked_songs();
               static void like_song(const std::string& name);
               static void unlike_song(const std::string& name);

               // queue
               static std::vector<std::string> shuffle_songs(const std::vector<std::string>& songs);

          private:
               static json load_playlists();
               static bool save_playlists(const json& data);
     };
}
