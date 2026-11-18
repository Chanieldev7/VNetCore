const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

esbuild
  .build({
    absWorkingDir: root,
    entryPoints: ["notifications.jsx"],
    outfile: "assets/notifications.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    minify: true,
    legalComments: "external",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "sonner-external-styles",
        setup(build) {
          build.onLoad(
            { filter: /[\\/]sonner[\\/]dist[\\/]index\.mjs$/ },
            async ({ path: filename }) => {
              const source = await fs.readFile(filename, "utf8");
              // Sonner 2 injects this stylesheet at module load. Use its official external
              // CSS instead, without weakening the app's Content Security Policy.
              const injection = /^__insertCSS\("(?:[^"\\]|\\.)*"\);\r?$/gm;
              if ([...source.matchAll(injection)].length !== 1) {
                throw new Error(
                  "Sonner's stylesheet loader changed. Review the CSP-safe build adapter before upgrading.",
                );
              }
              return { contents: source.replace(injection, ""), loader: "js" };
            },
          );
        },
      },
    ],
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
