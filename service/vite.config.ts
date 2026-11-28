import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "alphapact-pages-metadata",
      transformIndexHtml(html) {
        if (mode !== "pages") return html;
        return html.replace(
          /<meta name="description"[^>]*\/>\s*<title>[^<]+<\/title>/,
          '<meta name="description" content="제작자의 매매 전략을 고르고 내 계정에서 따라가는 AlphaPact입니다. 성과보수 모의 정산과 GIWA 테스트넷 거래를 확인하세요."/><title>AlphaPact — 내 계정에서 따라가는 자동매매 전략</title>',
        );
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 4132, proxy: { "/api": "http://127.0.0.1:4131" } },
}));
