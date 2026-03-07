import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./bottombar.js";
import { mockMetrics } from "../mock/factories.js";

const meta: Meta = {
  title: "Layout/Bottombar",
  component: "lens-bottombar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <lens-bottombar .metrics=${mockMetrics()}></lens-bottombar>
  `,
};
