cmake_minimum_required(VERSION 3.10)
project(yugen CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_executable(yugen
    src/services.cpp

    src/main.cpp
)

target_include_directories(yugen PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)

target_compile_options(yugen PRIVATE -Wall -Wextra)

include(FetchContent)

FetchContent_Declare(
    saucer
    GIT_REPOSITORY "https://github.com/saucer/saucer"
    GIT_TAG v8.0.5
)

FetchContent_MakeAvailable(saucer)

target_link_libraries(${PROJECT_NAME} PRIVATE saucer::saucer)

install(TARGETS yugen DESTINATION bin)
