# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-src")
  file(MAKE_DIRECTORY "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-src")
endif()
file(MAKE_DIRECTORY
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-build"
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix"
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/tmp"
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/src/saucer-fill-populate-stamp"
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/src"
  "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/src/saucer-fill-populate-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/src/saucer-fill-populate-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "/home/g4lice/Custom/Projects/yugen/_deps/saucer-fill-subbuild/saucer-fill-populate-prefix/src/saucer-fill-populate-stamp${cfgdir}") # cfgdir has leading slash
endif()
