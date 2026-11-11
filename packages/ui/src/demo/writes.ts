/** Content the scripted agents write into the demo file system (kept small: it ships in the initial bundle). */

const ORBIT_GRADLE_AFTER = `buildscript {
    ext {
        buildToolsVersion = "35.0.0"
        minSdkVersion = 24
        compileSdkVersion = 35
        targetSdkVersion = 34
        ndkVersion = "26.1.10909125"
        kotlinVersion = "1.9.24"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin")
    }
}

apply plugin: "com.facebook.react.rootproject"
`;

const ORBIT_METRO_AFTER = `const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const defaults = getDefaultConfig(__dirname);

module.exports = mergeConfig(defaults, {
  transformer: {
    babelTransformerPath: require.resolve("react-native-svg-transformer"),
  },
  resolver: {
    assetExts: defaults.resolver.assetExts.filter((ext) => ext !== "svg"),
    sourceExts: [...defaults.resolver.sourceExts, "svg"],
  },
});
`;

/** New content for the files the live Orbit run writes. */
export const ORBIT_WRITES = { gradle: ORBIT_GRADLE_AFTER, metro: ORBIT_METRO_AFTER };

export const ATLAS_CONCURRENT_TEST = `import { describe, expect, it } from "vitest";
import { testServer } from "../helpers/server";

describe("POST /auth/refresh (concurrent)", () => {
  it("keeps the user signed in when two tabs refresh at once", async () => {
    const app = await testServer();
    const cookies = { atlas_rt: "seed" };
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/refresh", cookies }),
      app.inject({ method: "POST", url: "/auth/refresh", cookies }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});
`;
