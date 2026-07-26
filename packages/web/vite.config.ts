import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiPort = Number.parseInt(process.env.MONDE_UI_PORT ?? "5175", 10);
const servicePort = Number.parseInt(process.env.MONDE_WEB_PORT ?? "3761", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: uiPort,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${servicePort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
