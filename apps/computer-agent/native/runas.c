// openbots-runas: the computer's one privileged piece (S-7).
//
//   openbots-runas UID GID -- PROGRAM [ARG...]
//   openbots-runas --clear-display N
//
// Runs PROGRAM as UID with GID as its only group. The control agent starts
// as root, lays out the screens' private directories, then sets its
// effective uid to the bot user (1000) and keeps root as its real and saved
// uid, with CHOWN, SETUID and SETGID in its permitted set only. Every program
// the agent starts goes through this helper. Started by the agent, the helper
// can take its effective uid back to 0 (its real uid), which restores those
// capabilities; it then drops every uid and gid to the target for good and
// execs. Started by anything else (a Bot's command, the terminal) its real uid
// is not 0, so it refuses. It is not setuid: the container runs with
// no-new-privileges, so a setuid bit would be ignored anyway.
//
// Only these identities are allowed (apps/computer-agent/src/users.ts):
//   1000:1000          the bot user: the terminal, commands without a screen
//   1000:(2000+n)      a command for the Bot of screen n, which may read
//                      that screen's Xauthority (group-readable)
//   (2000+n):(2000+n)  screen n's Xvfb, window manager, x11vnc and Chromium
//   1900:1900          the agent's reads and writes of the shared cookie
//                      store, whose directory no command or screen may enter
//
// --clear-display N removes whatever stands at screen N's X socket,
// /tmp/.X11-unix/X(10+N), so that its Xvfb can listen there. The agent makes
// that directory root's, mode 1777, before it drops to the bot user. A Bot's
// command may create the name first, and no screen user may remove it there;
// root may, as the directory's owner. The helper builds the path from N, so
// it removes nothing else, and leaves a directory that will not go under a
// random name instead. Xvfb runs with -nolock, so no lock file needs clearing.
//
// Built static, so no dynamic loader reads LD_* from the environment.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

#define BOT_ID 1000
#define SCREEN_ID_BASE 2000
#define STORE_ID 1900
#define MAX_SCREEN 89
#define DISPLAY_BASE 10
#define X11_DIR "/tmp/.X11-unix"

static int fail(const char *what) {
  fprintf(stderr, "openbots-runas: %s%s%s\n", what, errno ? ": " : "", errno ? strerror(errno) : "");
  return 126;
}

static int parse_id(const char *s, unsigned long *out) {
  char *end;
  if (*s < '0' || *s > '9') return -1;
  errno = 0;
  *out = strtoul(s, &end, 10);
  return errno || *end ? -1 : 0;
}

static int screen_id(unsigned long id) {
  return id >= SCREEN_ID_BASE && id <= SCREEN_ID_BASE + MAX_SCREEN;
}

static int allowed(unsigned long uid, unsigned long gid) {
  if (uid == BOT_ID) return gid == BOT_ID || screen_id(gid);
  if (uid == STORE_ID) return gid == STORE_ID;
  return screen_id(uid) && gid == uid;
}

static int clear_display(const char *arg) {
  unsigned long n;
  if (parse_id(arg, &n) || n > MAX_SCREEN) return fail("no such screen");
  if (seteuid(0) != 0) return fail("seteuid");
  int dir = open(X11_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat st;
  if (dir < 0 || fstat(dir, &st) != 0) return fail(X11_DIR);
  if (st.st_uid != 0) return fail(X11_DIR " is not root's");
  char name[16], aside[48];
  snprintf(name, sizeof name, "X%lu", DISPLAY_BASE + n);
  if (unlinkat(dir, name, 0) == 0 || errno == ENOENT) return 0;
  if (errno != EISDIR) return fail(name);
  if (unlinkat(dir, name, AT_REMOVEDIR) == 0) return 0;
  if (errno != ENOTEMPTY && errno != EEXIST) return fail(name);
  unsigned char r[8];
  if (getrandom(r, sizeof r, 0) != sizeof r) return fail("getrandom");
  snprintf(aside, sizeof aside, ".stale-%s-%02x%02x%02x%02x%02x%02x%02x%02x", name, r[0], r[1],
           r[2], r[3], r[4], r[5], r[6], r[7]);
  if (renameat(dir, name, dir, aside) != 0) return fail(name);
  return 0;
}

int main(int argc, char **argv) {
  unsigned long uid, gid;
  errno = 0;
  if (argc == 3 && strcmp(argv[1], "--clear-display") == 0) {
    if (getuid() != 0) return fail("only the control agent may clear a display");
    return clear_display(argv[2]);
  }
  if (argc < 5 || strcmp(argv[3], "--") != 0) return fail("usage: openbots-runas UID GID -- PROGRAM [ARG...]");
  if (parse_id(argv[1], &uid) || parse_id(argv[2], &gid) || !allowed(uid, gid))
    return fail("that uid and gid are not a computer identity");
  if (getuid() != 0) return fail("only the control agent may switch users");
  if (seteuid(0) != 0) return fail("seteuid");
  if (setgroups(0, NULL) != 0) return fail("setgroups");
  if (setresgid(gid, gid, gid) != 0) return fail("setresgid");
  if (setresuid(uid, uid, uid) != 0) return fail("setresuid");

  uid_t r, e, s;
  gid_t rg, eg, sg;
  if (getresuid(&r, &e, &s) != 0 || r != uid || e != uid || s != uid) return fail("uid check");
  if (getresgid(&rg, &eg, &sg) != 0 || rg != gid || eg != gid || sg != gid) return fail("gid check");
  if (getgroups(0, NULL) != 0) return fail("groups check");
  errno = 0;
  if (setuid(0) == 0 || seteuid(0) == 0) return fail("root is still reachable");

  execvp(argv[4], &argv[4]);
  int missing = errno == ENOENT;
  fail(argv[4]);
  return missing ? 127 : 126;
}
