cmake_minimum_required(VERSION 3.10)
project(yugen CXX)

# std::println and std::chrono::clock_cast are used throughout, both C++23.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# taglib has no cmake package, only a .pc file, so it comes in through
# pkg-config as ${TAGLIB_INCLUDE_DIRS} / ${TAGLIB_LIBRARIES}.
find_package(PkgConfig REQUIRED)
find_package(CURL REQUIRED)

pkg_check_modules(TAGLIB REQUIRED taglib)

# saucer (webview), nlohmann_json and the discord rpc library are pinned and
# built from source on the first configure, then cached under build/_deps.
#
# discord-presence pulls glaze in itself, but only when the target does not
# exist yet - saucer already brings the same version, so it is reused.
include(FetchContent)

FetchContent_Declare(
    saucer
    GIT_REPOSITORY "https://github.com/saucer/saucer"
    GIT_TAG v8.0.5
)

FetchContent_Declare(
    json
    GIT_REPOSITORY "https://github.com/nlohmann/json.git"
    GIT_TAG v3.11.3
)

FetchContent_Declare(
    discord-presence
    GIT_REPOSITORY "https://github.com/onegen-dev/discord-presence.git"
    GIT_TAG 3b50b0854ec24f9b2d4cc8e28f9145f276bb998e
)

FetchContent_MakeAvailable(saucer json discord-presence)

# The executable itself.
add_executable(${PROJECT_NAME}
    src/main.cpp
    src/services.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${TAGLIB_INCLUDE_DIRS}
)

target_compile_options(${PROJECT_NAME} PRIVATE
    -Wall
    -Wextra
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    nlohmann_json::nlohmann_json
    ${TAGLIB_LIBRARIES}
    saucer::saucer
    CURL::libcurl
    discord-rpc
)

# Installation.
install(TARGETS ${PROJECT_NAME} DESTINATION bin)
