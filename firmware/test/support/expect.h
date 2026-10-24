// A few check macros that run the same tests two ways: on Unity under `pio test -e native` (CI), and
// as a plain program built with the computer's own compiler by test/run-native.sh (no PlatformIO needed).
#pragma once

#include <cstdio>
#include <string>

#ifdef PIO_UNIT_TESTING

#include <unity.h>

#define CHECK(cond) TEST_ASSERT_TRUE_MESSAGE((cond), #cond)
#define CHECK_STR(actual, expected) \
  TEST_ASSERT_EQUAL_STRING(std::string(expected).c_str(), std::string(actual).c_str())
#define RUN(test) RUN_TEST(test)
#define TESTS_BEGIN() UNITY_BEGIN()
#define TESTS_END() return UNITY_END()

#else

namespace check {
inline int tests = 0;
inline int failures = 0;
inline const char* current = "";
}  // namespace check

#define CHECK(cond)                                                                                  \
  do {                                                                                               \
    if (!(cond)) {                                                                                   \
      ++check::failures;                                                                             \
      std::printf("FAIL %s:%d in %s: %s\n", __FILE__, __LINE__, check::current, #cond);              \
    }                                                                                                \
  } while (0)
#define CHECK_STR(actual, expected)                                                                  \
  do {                                                                                               \
    const std::string got_ = (actual), want_ = (expected);                                           \
    if (got_ != want_) {                                                                             \
      ++check::failures;                                                                             \
      std::printf("FAIL %s:%d in %s\n  got      %s\n  expected %s\n", __FILE__, __LINE__, check::current, \
                  got_.c_str(), want_.c_str());                                                      \
    }                                                                                                \
  } while (0)
#define RUN(test)              \
  do {                         \
    check::current = #test;    \
    ++check::tests;            \
    test();                    \
  } while (0)
#define TESTS_BEGIN()
#define TESTS_END()                                                                          \
  do {                                                                                       \
    std::printf("%d tests, %d failed checks\n", check::tests, check::failures);              \
    return check::failures == 0 ? 0 : 1;                                                     \
  } while (0)

#endif
