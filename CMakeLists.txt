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

# saucer (webview) and nlohmann_json are pinned to a tag and built from
# source on the first configure, then cached under build/_deps.
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

FetchContent_MakeAvailable(saucer json)

# The discord social sdk ships as a prebuilt .so with headers next to it,
# so there is nothing to build - only a path to point the linker at.
set(DISCORD_SDK_DIR
    ${CMAKE_CURRENT_SOURCE_DIR}/discord_social_sdk
)

set(DISCORD_SDK_LIB
    ${DISCORD_SDK_DIR}/lib/release/libdiscord_partner_sdk.so
)

# The executable itself.
add_executable(${PROJECT_NAME}
    src/main.cpp
    src/services.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${TAGLIB_INCLUDE_DIRS}
    ${DISCORD_SDK_DIR}/include
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
    ${DISCORD_SDK_LIB}
)

# the sdk .so is not installed system wide, so the binary carries its path
set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH "${DISCORD_SDK_DIR}/lib/release"
)

# Installation.
install(TARGETS ${PROJECT_NAME} DESTINATION bin)
