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

# gdbus, for the mpris interface in src/mpris.cpp. not a new dependency in
# practice - webkitgtk already drags glib into the process, this only puts the
# headers on the include path and asks the linker to be explicit about it.
pkg_check_modules(GIO REQUIRED gio-2.0)

# EXCLUDE_FROM_ALL keeps their own install rules out of ours, so installing
# yugen does not drop saucer's headers and cmake config into the prefix.
#
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
    EXCLUDE_FROM_ALL
)

FetchContent_Declare(
    json
    GIT_REPOSITORY "https://github.com/nlohmann/json.git"
    GIT_TAG v3.11.3
    EXCLUDE_FROM_ALL
)

FetchContent_Declare(
    saucer-embed
    GIT_REPOSITORY "https://github.com/saucer/embed"
    GIT_TAG v1.1.1
    EXCLUDE_FROM_ALL
)

FetchContent_Declare(
    discord-presence
    GIT_REPOSITORY "https://github.com/onegen-dev/discord-presence.git"
    GIT_TAG 3b50b0854ec24f9b2d4cc8e28f9145f276bb998e
    EXCLUDE_FROM_ALL
)

FetchContent_MakeAvailable(saucer json saucer-embed discord-presence)

# The built ui is baked into the executable, so there is nothing to serve at
# runtime and nothing to install next to the binary. The directory is globbed
# when cmake configures, so `npm run build` in ui/ has to have run at least
# once; after that the generated sources are refreshed on every build.
set(YUGEN_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/ui/dist")

# The executable itself.
add_executable(${PROJECT_NAME}
    src/main.cpp
    src/mpris.cpp
    src/services.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${TAGLIB_INCLUDE_DIRS}
    ${GIO_INCLUDE_DIRS}
)

target_compile_options(${PROJECT_NAME} PRIVATE
    -Wall
    -Wextra
)

if (NOT EXISTS "${YUGEN_UI_DIR}/index.html")
    message(FATAL_ERROR
        "No ui bundle at ${YUGEN_UI_DIR} - run `npm run build` in ui/ first.")
endif()

saucer_embed("${YUGEN_UI_DIR}"
    NAME        ui
    TARGET      ${PROJECT_NAME}
    DESTINATION "${CMAKE_CURRENT_BINARY_DIR}/embedded"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    nlohmann_json::nlohmann_json
    saucer::ui
    ${TAGLIB_LIBRARIES}
    ${GIO_LIBRARIES}
    saucer::saucer
    CURL::libcurl
    discord-rpc
)

# Installation. The default prefix is /usr/local, so `sudo cmake --install build`
# puts the binary on PATH and registers the desktop entry with it.
install(TARGETS ${PROJECT_NAME} DESTINATION bin)

install(FILES assets/yugen.desktop DESTINATION share/applications)

# the icon theme wants one file per size, each named after the application, so
# the sizes that exist in assets/icons are renamed into their hicolor directory
foreach(SIZE 16 32 48 128 256 512)
    install(FILES  assets/icons/yugen_${SIZE}.png
            DESTINATION share/icons/hicolor/${SIZE}x${SIZE}/apps
            RENAME yugen.png)
endforeach()
