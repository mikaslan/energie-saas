#include <sys/prctl.h>
#include <unistd.h>

/*
 * The PDF renderer is a same-UID child of the database worker. A reduced
 * execve environment alone does not protect the parent's /proc data. This
 * constructor runs inside the Node worker before application code and makes
 * the process non-dumpable, so Linux ptrace-gated /proc files (environ, mem,
 * fd links) are not readable by the Chromium child. The browser does not
 * inherit this preload and keeps its normal sandbox startup behaviour.
 */
__attribute__((constructor)) static void disable_worker_dumpability(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    static const char message[] = "worker process isolation failed\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(127);
  }
}
