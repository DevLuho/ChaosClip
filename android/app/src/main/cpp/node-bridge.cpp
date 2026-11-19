// Lance Node (nodejs-mobile) dans le processus de l'appli.
#include <jni.h>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

// stdout/stderr de Node partent dans logcat (étiquette ChaosClipNode) :
// sans ça, une erreur au démarrage du serveur est invisible.
static void pipeToLogcat() {
  static int fds[2];
  if (pipe(fds) != 0) return;
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  dup2(fds[1], STDOUT_FILENO);
  dup2(fds[1], STDERR_FILENO);
  std::thread([] {
    char buf[2048];
    ssize_t n;
    while ((n = read(fds[0], buf, sizeof buf - 1)) > 0) {
      buf[n] = 0;
      __android_log_write(ANDROID_LOG_INFO, "ChaosClipNode", buf);
    }
  }).detach();
}

extern "C" JNIEXPORT jint JNICALL
Java_fr_devluho_chaosclip_MainActivity_startNode(JNIEnv *env, jobject, jobjectArray args) {
  pipeToLogcat();
  // libuv exige des argv contigus en mémoire.
  jsize argc = env->GetArrayLength(args);
  std::string flat;
  std::vector<size_t> offsets;
  for (jsize i = 0; i < argc; i++) {
    auto s = (jstring) env->GetObjectArrayElement(args, i);
    const char *c = env->GetStringUTFChars(s, nullptr);
    offsets.push_back(flat.size());
    flat.append(c).push_back('\0');
    env->ReleaseStringUTFChars(s, c);
  }
  std::vector<char *> argv;
  for (size_t o : offsets) argv.push_back(&flat[o]);
  return node::Start(argc, argv.data());
}
