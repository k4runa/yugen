cmake_minimum_required(VERSION 3.10)
project(yugen CXX)

set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)


find_package(PkgConfig REQUIRED)
find_package(CURL REQUIRED)

pkg_check_modules(TAGLIB REQUIRED taglib)

add_executable(yugen
    src/services.cpp

    src/main.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_include_directories(${PROJECT_NAME} PRIVATE ${TAGLIB_INCLUDE_DIRS})

target_compile_options(yugen PRIVATE -Wall -Wextra)

include(FetchContent)

FetchContent_Declare(
    saucer
    GIT_REPOSITORY "https://github.com/saucer/saucer"
    GIT_TAG v8.0.5
)

FetchContent_Declare(
  json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
)

FetchContent_MakeAvailable(saucer)
FetchContent_MakeAvailable(json)

target_link_libraries(${PROJECT_NAME} PRIVATE nlohmann_json::nlohmann_json)
target_link_libraries(${PROJECT_NAME} PRIVATE ${TAGLIB_LIBRARIES})
target_link_libraries(${PROJECT_NAME} PRIVATE saucer::saucer)
target_link_libraries(${PROJECT_NAME} PRIVATE CURL::libcurl)

install(TARGETS yugen DESTINATION bin)
