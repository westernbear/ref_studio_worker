// Manual smoke test for Task 2.5, Step 5: render the hand-written fixture
// SceneSpec through a real, non-mocked Chromium and ffmpeg, and write the
// result to /tmp/fixture.mp4 so it can be played back and eyeballed --
// three beats, in order, 600 frames at 30fps / 9:16.
//
// Run with: node_modules/.pnpm/node_modules/.bin/vite-node
//   apps/worker/scripts/render-fixture-spec.ts
// (tsx is not present in this sandbox; vite-node gives the same
// TS-source-via-.js-specifier resolution this repo's NodeNext imports rely
// on.)
import { fixtureSpec } from "@rvs/contracts";
import { renderGeneratedDelivery } from "../src/gen-render-delivery.js";

const chromePath =
  process.env.RVS_CHROME_PATH ??
  new URL(
    "../../../runtime/hydrated/chrome-for-testing/chrome-linux64/chrome",
    import.meta.url,
  ).pathname;
const fontPath = new URL(
  "../../../runtime/hydrated/wanted-sans/variable/WantedSansVariable.ttf",
  import.meta.url,
).pathname;

async function main(): Promise<void> {
  const report = await renderGeneratedDelivery(
    {
      spec: fixtureSpec,
      assetPaths: new Map(),
      outPath: "/tmp/fixture.mp4",
    },
    { chromePath, fontPath },
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
