import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./split-layout.js";

const meta: Meta = {
  title: "Layout/SplitLayout",
  component: "lens-split-layout",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj;

const slotStyle = (color: string, label: string) =>
  `display:flex;align-items:center;justify-content:center;background:${color};color:#fff;font-family:monospace;font-size:11px;height:100%;min-height:0;`;

export const Default: Story = {
  render: () => html`
    <lens-split-layout>
      <div slot="topbar" style=${slotStyle("#1a0a2a", "topbar")}>TOPBAR</div>
      <div slot="narrative" style=${slotStyle("#0a1a2a", "narrative")}>NARRATIVE</div>
      <div slot="sidebar" style=${slotStyle("#0a2a1a", "sidebar")}>SIDEBAR</div>
      <div slot="center" style=${slotStyle("#1a1a1a", "center")}>CENTER</div>
      <div slot="right" style=${slotStyle("#2a1a0a", "right")}>RIGHT PANEL</div>
      <div slot="bottombar" style=${slotStyle("#1a0a2a", "bottombar")}>BOTTOMBAR</div>
    </lens-split-layout>
  `,
};
