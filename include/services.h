#pragma once

#include <string>
#include <vector>
#include "../include/miniaudio.h"

namespace yugen
{
     std::vector<std::string> fetch_covers(const std::string& file_path);
     void play(ma_engine *engine, const std::string& file_path);
     float get_pos();
     float get_len();
     void stop();
     void resume();
     void toggle_loop();
}
