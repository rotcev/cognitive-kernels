import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./command-palette.js";

const meta: Meta = {
  title: "Domain/CommandPalette",
  component: "lens-command-palette",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const sampleSuggestions = [
  { icon: ">", label: "Show process tree" },
  { icon: "?", label: "Explain current state" },
  { icon: "#", label: "Search blackboard" },
];

export const Open: Story = {
  render: () => {
    const el = document.createElement("lens-command-palette") as any;
    el.open = true;
    el.suggestions = sampleSuggestions;
    el.addEventListener("close", () => { el.open = false; });
    el.addEventListener("query", (e: CustomEvent) => { console.log("query:", e.detail); });
    el.addEventListener("select", (e: CustomEvent) => { console.log("select:", e.detail); });
    return el;
  },
};

export const Closed: Story = {
  render: () => html`<lens-command-palette></lens-command-palette>`,
};
