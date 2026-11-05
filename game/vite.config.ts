import { defineConfig } from "vite";

// base "./": страница работает и на https://<user>.github.io/<repo>/, и локально.
// Код сборки кладётся в app/, чтобы не смешиваться с картинками из public/assets.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", assetsDir: "app", assetsInlineLimit: 0 },
});
