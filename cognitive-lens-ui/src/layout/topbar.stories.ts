import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./topbar.js";

const meta: Meta = {
  title: "Layout/Topbar",
  component: "lens-topbar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Connected: Story = {
  render: () => html`
    <lens-topbar
      brandName="Cognitive Lens"
      runLabel="b54ef6df — JWT Auth"
      elapsed="02:58"
      .connected=${true}
    ></lens-topbar>
  `,
};

export const Disconnected: Story = {
  render: () => html`
    <lens-topbar
      brandName="Cognitive Lens"
      runLabel="b54ef6df — JWT Auth"
      elapsed="02:58"
      .connected=${false}
    ></lens-topbar>
  `,
};
