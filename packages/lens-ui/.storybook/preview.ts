import type { Preview } from "@storybook/web-components";
import theme from "./theme";
import "../src/tokens/tokens.css";

const preview: Preview = {
  parameters: {
    docs: { theme },
    backgrounds: {
      default: "lens-root",
      values: [
        { name: "lens-root", value: "#000000" },
        { name: "lens-panel", value: "#050505" },
        { name: "lens-surface", value: "#0a0a0a" },
      ],
    },
    layout: "centered",
  },
};

export default preview;
