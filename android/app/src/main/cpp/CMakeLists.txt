cmake_minimum_required(VERSION 3.22.1)
project(nodebridge)
set(CMAKE_CXX_STANDARD 17)

set(LIBNODE ${CMAKE_SOURCE_DIR}/../../../libnode)
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${LIBNODE}/bin/${ANDROID_ABI}/libnode.so)

add_library(nodebridge SHARED node-bridge.cpp)
target_include_directories(nodebridge PRIVATE ${LIBNODE}/include/node)
target_link_libraries(nodebridge node log)
