// plugins/withWindowsLongPathFix.js
//
// Durable fix for the Windows 260-char CMake/ninja path limit on `expo
// run:android`. Because `expo prebuild --clean` regenerates android/ and wipes
// manual edits, this config plugin re-applies the fix on every prebuild.
//
// It does two things to android/app/build.gradle:
//   1. Pins a modern CMake (>=3.30 ships ninja >=1.12, which honors long paths;
//      AGP otherwise defaults to CMake 3.22.1 / ninja 1.10, which does not).
//   2. Redirects the deep .cxx native intermediates to a very short absolute
//      root (default C:\b\<project>), cutting the longest generated paths.
//
// Config (app.json): ["./plugins/withWindowsLongPathFix", { "cmakeVersion": "3.31.6", "shortBuildRoot": "C:\\b" }]
// Both keys optional. Only affects Windows builds; no-op on macOS/Linux since
// the extra Gradle lines are inert there.

const { withAppBuildGradle } = require("@expo/config-plugins");

const DEFAULT_CMAKE = "3.31.6";
const DEFAULT_ROOT = "C:\\\\b"; // escaped backslashes for the generated Groovy string

function applyGradleFix(contents, cmakeVersion, shortBuildRoot) {
  let out = contents;

  // 1. Redirect build output (incl. .cxx) to a short root, right after the
  // android { line. Idempotent via a marker comment.
  if (!out.includes("// withWindowsLongPathFix")) {
    out = out.replace(
      /android\s*\{/,
      `android {
    // withWindowsLongPathFix: shorten native build paths on Windows
    if (System.getProperty('os.name').toLowerCase().contains('windows')) {
        project.layout.buildDirectory.set(new File("${shortBuildRoot}\\\\" + project.name))
    }`
    );
  }

  // 2. Pin CMake version inside the existing externalNativeBuild { cmake { }
  // block if present; otherwise inject a defaultConfig-level one.
  if (/externalNativeBuild\s*\{[\s\S]*?cmake\s*\{/.test(out)) {
    if (!/cmake\s*\{[\s\S]*?version\s+/.test(out)) {
      out = out.replace(
        /(externalNativeBuild\s*\{\s*cmake\s*\{)/,
        `$1
            version "${cmakeVersion}"`
      );
    }
  } else {
    out = out.replace(
      /defaultConfig\s*\{/,
      `defaultConfig {
        externalNativeBuild {
            cmake {
                version "${cmakeVersion}"
                arguments "-DCMAKE_OBJECT_PATH_MAX=1024"
            }
        }`
    );
  }

  return out;
}

module.exports = function withWindowsLongPathFix(config, props = {}) {
  const cmakeVersion = props.cmakeVersion || DEFAULT_CMAKE;
  const shortBuildRoot = (props.shortBuildRoot || DEFAULT_ROOT).replace(/\\/g, "\\\\");
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language === "groovy") {
      cfg.modResults.contents = applyGradleFix(
        cfg.modResults.contents,
        cmakeVersion,
        shortBuildRoot
      );
    }
    return cfg;
  });
};
