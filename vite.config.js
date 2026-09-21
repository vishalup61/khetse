import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Purez",
        short_name: "Purez",
        description: "Fresh and trusted products, directly to your home.",
        theme_color: "#174A2E",
        background_color: "#FFFDF5",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/purez-logo.svg",
            sizes: "any",
            type: "image/svg+xml"
          }
        ]
      }
    })
  ]
});